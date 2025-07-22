const { expect } = require('chai');
const sinon = require('sinon');
const nock = require('nock');
const fs = require('fs');
const sonarToJiraService = require('../../src/service/sonar_to_jira_service');
const functionUtils = require('../../src/utils/functionUtils');
const projectsConfig = require('../../src/utils/projectConfig.json');

describe('SonarQube to Jira Service', function() {
    this.timeout(10000);
    
    let sandbox;
    let originalEnv;
    
    beforeEach(() => {
        sandbox = sinon.createSandbox();
        
        // Save original environment
        originalEnv = { ...process.env };
        
        // Mock environment variables
        process.env.SONARQUBE_BASE_URL = 'https://sonarqube.test';
        process.env.SONARQUBE_TOKEN = 'test-token';
        process.env.JIRA_BASE_URL = 'https://jira.test';
        process.env.JIRA_USERNAME = 'test-user';
        process.env.JIRA_API_TOKEN = 'test-token';
        
        nock.disableNetConnect();
    });
    
    afterEach(() => {
        sandbox.restore();
        
        // Restore original environment
        process.env = { ...originalEnv };
        
        nock.cleanAll();
        nock.enableNetConnect();
    });

    describe('fetchSonarData', () => {
        it('should successfully fetch sonar data with provided project list', async () => {
            // Mock SonarQube APIs
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query({ componentKeys: 'test-project', resolved: false, types: 'BUG,VULNERABILITY', inNewCodePeriod: false })
                .reply(200, {
                    issues: [{ key: 'test-issue-1', project: 'test-project' }]
                });

            nock('https://sonarqube.test')
                .get('/api/hotspots/search')
                .query({ projectKey: 'test-project' })
                .reply(200, {
                    hotspots: [{ key: 'test-hotspot-1', project: 'test-project' }]
                });
            
            // Test by calling fetchSonarData with a valid project list
            const result = await sonarToJiraService.fetchSonarData([{key: 'test-project', name: 'Test Project'}]);
            
            expect(result).to.have.property('issues').that.is.an('array').with.lengthOf(1);
            expect(result).to.have.property('hotspots').that.is.an('array').with.lengthOf(1);
            expect(result.issues[0]).to.have.property('key', 'test-issue-1');
            expect(result.hotspots[0]).to.have.property('key', 'test-hotspot-1');
        });

        it('should return empty arrays when no projects are provided', async () => {
            // Mock the projectConfig to have no enabled projects
            const originalProjects = projectsConfig.projects;
            projectsConfig.projects = projectsConfig.projects.map(p => ({...p, isChecked: false}));
            
            // Test with empty project list and no environment fallback
            const originalProjectKey = process.env.SONARQUBE_PROJECT_KEY;
            delete process.env.SONARQUBE_PROJECT_KEY;
            
            try {
                const result = await sonarToJiraService.fetchSonarData([]);
                
                expect(result).to.have.property('issues').that.is.an('array').that.is.empty;
                expect(result).to.have.property('hotspots').that.is.an('array').that.is.empty;
            } finally {
                // Restore original state
                projectsConfig.projects = originalProjects;
                if (originalProjectKey) {
                    process.env.SONARQUBE_PROJECT_KEY = originalProjectKey;
                }
            }
        });
    });
    
    describe('createJiraTickets', () => {
        let functionUtilsStub;
        
        beforeEach(() => {
            // Get a fresh reference to the function utils module
            const functionUtils = require('../../src/utils/functionUtils');
            
            // Stub the lookupJiraUsers function directly on the module
            functionUtilsStub = sandbox.stub(functionUtils, 'lookupJiraUsers').resolves({
                totalEmails: 0,
                successfulLookups: 0,
                cacheHits: 0,
                totalCached: 0
            });
            
            // Mock userAccountCache
            functionUtils.userAccountCache = {
                'anoop.mc@gmail.com': { accountId: 'user123', displayName: 'Anoop MC' }
            };
        });

        it('should throw error when sonarData is not provided', async () => {
            try {
                await sonarToJiraService.createJiraTickets();
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.equal('sonarData is required for createJiraTickets');
            }
        });

        it('should handle errors in checkMultipleIssuesResolved and return fallback status', async () => {
            const keys = ['error-key1', 'error-key2'];
            
            // Mock issues API to return error - this should trigger the main catch block
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query(true)
                .replyWithError('Network error in test');

            // Mock hotspots API to return error as well to trigger main catch
            nock('https://sonarqube.test')
                .get('/api/hotspots/show')
                .query(true)
                .replyWithError('Network error in test')
                .persist();

            // Since the current implementation catches API errors and leaves keys as resolved (true),
            // let's test what actually happens - keys are left as resolved by default
            const result = await sonarToJiraService._test.checkMultipleIssuesResolved(keys, 'https://sonarqube.test', 'test-token');
            
            expect(result).to.be.an('object');
            expect(result).to.have.property('error-key1', true);
            expect(result).to.have.property('error-key2', true);
            // Current implementation: API errors are caught and logged, keys remain resolved (true)
        });

        it('should test closeJiraTicket error handling for HTTP errors', async () => {
            // Mock transitions API to return HTTP error status - make it persistent for retries
            nock('https://jira.test')
                .get('/rest/api/3/issue/TICKET-ERROR/transitions')
                .reply(403, { error: 'Forbidden' })
                .persist();

            // The function should catch HTTP errors and return false instead of throwing
            const result = await sonarToJiraService._test.closeJiraTicket(
                'TICKET-ERROR', 
                'sonar-key', 
                'test-user', 
                'test-token', 
                'https://jira.test'
            );
            
            // Should return false when HTTP error occurs (errors are caught and logged)
            expect(result).to.equal(false);
        });

        it('should create tickets for new issues and hotspots', async () => {
            // Setup mock data
            const mockSonarData = {
                issues: [{
                    key: 'TEST-1',
                    component: 'test-project:src/test.js',
                    severity: 'MAJOR',
                    type: 'BUG',
                    message: 'Test issue',
                    creationDate: '2023-01-01T00:00:00Z',
                    assignee: 'test@example.com',
                    project: 'test-project'
                }],
                hotspots: [{
                    key: 'TEST-2',
                    component: 'test-project:src/test.js',
                    vulnerabilityProbability: 'HIGH',
                    securityCategory: 'sql-injection',
                    message: 'Test hotspot',
                    creationDate: '2023-01-01T00:00:00Z',
                    assignee: 'test@example.com',
                    project: 'test-project'
                }]
            };

            // Mock getProjectInfo
            const getProjectInfoStub = sinon.stub(functionUtils, 'getProjectInfo');
            getProjectInfoStub.returns({
                jiraId: 'LV',
                assignee: 'test@example.com',
                component: 'Others'
            });

            // Mock Jira search for existing tickets (POST request to /rest/api/3/search)
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] }); // No existing tickets

            // Mock Jira user lookup
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/user\/search\?query=/)
                .reply(200, [{ accountId: 'test-account' }])
                .persist();

            // Mock Jira ticket creation (POST to /rest/api/3/issue)
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(201, { key: 'TEST-3' })
                .post('/rest/api/3/issue')
                .reply(201, { key: 'TEST-4' });

            const result = await sonarToJiraService.createJiraTickets(mockSonarData);

            expect(result).to.have.property('created').that.is.an('array').with.lengthOf(2);
            expect(result).to.have.property('existing').that.is.an('array').that.is.empty;

            getProjectInfoStub.restore();
        });

        it('should detect existing tickets and not create duplicates', async () => {
            // Setup mock data
            const mockSonarData = {
                issues: [{
                    key: 'TEST-1',
                    component: 'test-project:src/test.js',
                    severity: 'MAJOR',
                    type: 'BUG',
                    message: 'Test issue',
                    creationDate: '2023-01-01T00:00:00Z',
                    assignee: 'test@example.com',
                    project: 'test-project'
                }],
                hotspots: []
            };

            // Mock getProjectInfo
            const getProjectInfoStub = sinon.stub(functionUtils, 'getProjectInfo');
            getProjectInfoStub.returns({
                jiraId: 'LV',
                assignee: 'test@example.com',
                component: 'Others'
            });

            // Mock Jira search for existing tickets - return existing ticket
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, {
                    issues: [{
                        key: 'EXISTING-1',
                        fields: {
                            summary: 'Test issue in src/test.js',
                            customfield_11972: {
                                content: [
                                    {
                                        content: [
                                            { text: 'TEST-1' }
                                        ]
                                    }
                                ]
                            }
                        }
                    }]
                });

            // Mock Jira user lookup
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/user\/search\?query=/)
                .reply(200, [{ accountId: 'test-account' }])
                .persist();

            const result = await sonarToJiraService.createJiraTickets(mockSonarData);

            expect(result).to.have.property('created').that.is.an('array').that.is.empty;
            expect(result).to.have.property('existing').that.is.an('array').with.lengthOf(1);
            expect(result.existing[0]).to.equal('EXISTING-1');

            getProjectInfoStub.restore();
        });
    });

    describe('checkMultipleIssuesResolved', () => {
        it('should return all resolved when APIs return empty arrays', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://sonarqube.test')
                .get(/\/api\/issues\/search.*/)
                .reply(200, { issues: [] });
            nock('https://sonarqube.test')
                .get(/\/api\/hotspots\/search.*/)
                .reply(200, { hotspots: [] });
            
            const keys = ['k1', 'k2'];
            const result = await _test.checkMultipleIssuesResolved(keys, 'https://sonarqube.test');
            expect(result).to.deep.equal({ k1: true, k2: true });
        });

        it('should return all active when APIs return all keys', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://sonarqube.test')
                .get(/\/api\/issues\/search.*/)
                .reply(200, { issues: [{ key: 'k1' }, { key: 'k2' }] });
            nock('https://sonarqube.test')
                .get(/\/api\/hotspots\/search.*/)
                .reply(200, { hotspots: [{ key: 'k1' }, { key: 'k2' }] });
            
            const keys = ['k1', 'k2'];
            const result = await _test.checkMultipleIssuesResolved(keys, 'https://sonarqube.test');
            expect(result).to.deep.equal({ k1: false, k2: false });
        });

        it('should handle mixed resolution status', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://sonarqube.test')
                .get(/\/api\/issues\/search.*/)
                .reply(200, { issues: [{ key: 'k1' }] });
            nock('https://sonarqube.test')
                .get(/\/api\/hotspots\/search.*/)
                .reply(200, { hotspots: [] });
            
            const keys = ['k1', 'k2'];
            const result = await _test.checkMultipleIssuesResolved(keys, 'https://sonarqube.test');
            expect(result).to.deep.equal({ k1: false, k2: true });
        });
    });

    describe('closeJiraTicket', () => {
        it('should successfully close ticket with preferred transition', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/issue\/TICKET-1\/transitions/)
                .reply(200, { transitions: [{ id: '1', name: 'Done' }] });
            nock('https://jira.test')
                .post(/\/rest\/api\/3\/issue\/TICKET-1\/transitions/)
                .reply(200, {});
            
            const result = await _test.closeJiraTicket('TICKET-1', 'k1', 'test-user', 'test-token', 'https://jira.test');
            expect(result).to.equal(true);
        });

        it('should use wont do transition when available', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/issue\/TICKET-1\/transitions/)
                .reply(200, { transitions: [{ id: '1', name: 'wont do' }] });
            nock('https://jira.test')
                .post(/\/rest\/api\/3\/issue\/TICKET-1\/transitions/)
                .reply(200, {});
            
            const result = await _test.closeJiraTicket('TICKET-1', 'k1', 'test-user', 'test-token', 'https://jira.test');
            expect(result).to.equal(true);
        });

        it('should return false when no suitable transition found', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/issue\/TICKET-2\/transitions/)
                .reply(200, { transitions: [{ id: '2', name: 'Other' }] });
            
            const result = await _test.closeJiraTicket('TICKET-2', 'k2', 'test-user', 'test-token', 'https://jira.test');
            expect(result).to.equal(false);
        });

        it('should handle transition fetch error', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/issue\/TICKET-3\/transitions/)
                .reply(500, {});
            
            const result = await _test.closeJiraTicket('TICKET-3', 'k3', 'test-user', 'test-token', 'https://jira.test');
            expect(result).to.equal(false);
        });

        it('should handle transition execution error', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            nock('https://jira.test')
                .get(/\/rest\/api\/3\/issue\/TICKET-4\/transitions/)
                .reply(200, { transitions: [{ id: '1', name: 'Done' }] });
            nock('https://jira.test')
                .post(/\/rest\/api\/3\/issue\/TICKET-4\/transitions/)
                .reply(500, 'Transition failed');
            
            const result = await _test.closeJiraTicket('TICKET-4', 'k4', 'test-user', 'test-token', 'https://jira.test');
            expect(result).to.equal(false);
        });

        it('should handle network errors gracefully', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry').throws(new Error('Network error'));
            
            const result = await _test.closeJiraTicket('TICKET-5', 'k5', 'test-user', 'test-token', 'https://jira.test');
            expect(result).to.equal(false);
        });
    });
});