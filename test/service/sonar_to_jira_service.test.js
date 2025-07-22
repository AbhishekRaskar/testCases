const { expect } = require('chai');
const sinon = require('sinon');
const nock = require('nock');
const sonarToJiraService = require('../../src/service/sonar_to_jira_service');
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

    describe('validateEnvironmentVariables', () => {
        it('should throw error when required environment variables are missing', () => {
            delete process.env.SONARQUBE_BASE_URL;
            
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            expect(() => _test.validateEnvironmentVariables())
                .to.throw('Missing required environment variable: SONARQUBE_BASE_URL');
        });

        it('should not throw when all required environment variables are present', () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            expect(() => _test.validateEnvironmentVariables()).to.not.throw();
        });
    });
    
    describe('fetchSonarData', () => {
        it('should return empty arrays when no projects are enabled', async () => {
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects.forEach(p => p.isChecked = false);
            delete process.env.SONARQUBE_PROJECT_KEY;
            
            const result = await sonarToJiraService.fetchSonarData();
            
            expect(result).to.have.property('issues').that.is.an('array').that.is.empty;
            expect(result).to.have.property('hotspots').that.is.an('array').that.is.empty;
            
            projectsConfig.projects = originalProjects;
        });
        
        it('should fetch issues and hotspots for enabled projects', async () => {
            const originalProjects = JSON.parse(JSON.stringify(projectsConfig.projects));
            const testProjects = [
                { key: 'test-project-1', name: 'Test Project 1', isChecked: true },
                { key: 'test-project-2', name: 'Test Project 2', isChecked: true }
            ];
            projectsConfig.projects = testProjects;
            
            // Mock processSingleProject function to resolve immediately without network calls
            const processSingleProjectStub = sandbox.stub(require('../../src/utils/functionUtils'), 'processSingleProject');
            processSingleProjectStub.onFirstCall().resolves();
            processSingleProjectStub.onSecondCall().resolves();
            
            // Mock the arrays to simulate data being added
            const mockIssues = [{ key: 'issue-1', project: 'test-project-1' }, { key: 'issue-2', project: 'test-project-2' }];
            const mockHotspots = [{ key: 'hotspot-1', project: 'test-project-1' }, { key: 'hotspot-2', project: 'test-project-2' }];
            
            processSingleProjectStub.onFirstCall().callsFake(async (projectKey, issueUrl, hotspotUrl, token, password, issues, hotspots) => {
                issues.push(mockIssues[0]);
                hotspots.push(mockHotspots[0]);
            });
            processSingleProjectStub.onSecondCall().callsFake(async (projectKey, issueUrl, hotspotUrl, token, password, issues, hotspots) => {
                issues.push(mockIssues[1]);
                hotspots.push(mockHotspots[1]);
            });
            
            const result = await sonarToJiraService.fetchSonarData();
            
            expect(result.issues).to.have.lengthOf(2);
            expect(result.hotspots).to.have.lengthOf(2);
            
            projectsConfig.projects = originalProjects;
        });

        it('should handle errors gracefully and throw enhanced error', async () => {
            const processSingleProjectStub = sandbox.stub(require('../../src/utils/functionUtils'), 'processSingleProject');
            processSingleProjectStub.rejects(new Error('Network error'));
            
            process.env.SONARQUBE_PROJECT_KEY = 'fallback-key';
            
            try {
                await sonarToJiraService.fetchSonarData();
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('SonarQube fetch failed');
                expect(error.message).to.include('Network error');
            } finally {
                delete process.env.SONARQUBE_PROJECT_KEY;
            }
        });

        it('should fallback to SONARQUBE_PROJECT_KEY if no enabled projects', async () => {
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects.forEach(p => p.isChecked = false);
            process.env.SONARQUBE_PROJECT_KEY = 'fallback-key';

            const processSingleProjectStub = sandbox.stub(require('../../src/utils/functionUtils'), 'processSingleProject');
            processSingleProjectStub.callsFake(async (projectKey, issueUrl, hotspotUrl, token, password, issues, hotspots) => {
                issues.push({ key: 'fallback-issue', project: 'fallback-key' });
                hotspots.push({ key: 'fallback-hotspot', project: 'fallback-key' });
            });

            const result = await sonarToJiraService.fetchSonarData();
            expect(result.issues).to.have.lengthOf(1);
            expect(result.hotspots).to.have.lengthOf(1);

            projectsConfig.projects = originalProjects;
            delete process.env.SONARQUBE_PROJECT_KEY;
        });

        it('should process projects with missing keys gracefully', async () => {
            const originalProjects = JSON.parse(JSON.stringify(projectsConfig.projects));
            projectsConfig.projects = [
                { name: 'NoKeyProject', isChecked: true },
                { key: 'valid-project', name: 'Valid Project', isChecked: true }
            ];

            const processSingleProjectStub = sandbox.stub(require('../../src/utils/functionUtils'), 'processSingleProject');
            processSingleProjectStub.callsFake(async (projectKey, issueUrl, hotspotUrl, token, password, issues, hotspots) => {
                if (projectKey === 'valid-project') {
                    issues.push({ key: 'valid-issue', project: 'valid-project' });
                }
            });

            const result = await sonarToJiraService.fetchSonarData();
            // Should process both projects, but only valid-project will add issues
            expect(result.issues).to.have.lengthOf(1);
            expect(processSingleProjectStub.calledTwice).to.be.true;

            projectsConfig.projects = originalProjects;
        });

        it('should use provided projectList parameter', async () => {
            const projectList = ['project-a', 'project-b'];
            
            const processSingleProjectStub = sandbox.stub(require('../../src/utils/functionUtils'), 'processSingleProject');
            processSingleProjectStub.callsFake(async (projectKey, issueUrl, hotspotUrl, token, password, issues, hotspots) => {
                issues.push({ key: `issue-${projectKey}`, project: projectKey });
                hotspots.push({ key: `hotspot-${projectKey}`, project: projectKey });
            });

            const result = await sonarToJiraService.fetchSonarData(projectList);
            expect(result.issues).to.have.lengthOf(2);
            expect(result.hotspots).to.have.lengthOf(2);
            expect(processSingleProjectStub.calledTwice).to.be.true;
        });
    });
    
    describe('createJiraTickets', () => {
        beforeEach(() => {
            // Mock lookupJiraUsers
            sandbox.stub(require('../../src/utils/functionUtils'), 'lookupJiraUsers').resolves();
            
            // Mock userAccountCache
            const functionUtils = require('../../src/utils/functionUtils');
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

        it('should handle empty issues and hotspots', async () => {
            // Mock Jira search (no existing tickets)
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });

            const result = await sonarToJiraService.createJiraTickets({
                issues: [],
                hotspots: []
            });
            
            expect(result).to.have.property('created').that.is.an('array').that.is.empty;
            expect(result).to.have.property('existing').that.is.an('array').that.is.empty;
        });

        it('should create tickets for new issues and skip existing ones', async () => {
            // Mock getProjectInfo
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: 'test-component',
                assignee: 'anoop.mc@gmail.com'
            });
            
            // Mock Jira search to find existing tickets
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, {
                    issues: [
                        {
                            key: 'LV-123',
                            fields: {
                                customfield_11972: {
                                    content: [
                                        {
                                            content: [
                                                { text: 'existing-issue-key' }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    ]
                });
            
            // Mock Jira ticket creation
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(200, { key: 'LV-456' });
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { 
                        key: 'new-issue-key',
                        project: 'test-project',
                        component: 'test-project:path/to/file.js',
                        message: 'New issue',
                        severity: 'MAJOR',
                        type: 'BUG'
                    },
                    { 
                        key: 'existing-issue-key',
                        project: 'test-project',
                        component: 'test-project:path/to/another-file.js',
                        message: 'Existing issue',
                        severity: 'CRITICAL',
                        type: 'BUG'
                    }
                ],
                hotspots: []
            });
            
            expect(result).to.have.property('created').that.includes('LV-456');
            expect(result).to.have.property('existing').that.includes('LV-123');
        });

        it('should handle very long summary by truncating', async () => {
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: 'test-component',
                assignee: 'anoop.mc@gmail.com'
            });
            
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });
            
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(200, { key: 'LV-789' });
            
            const longMessage = 'a'.repeat(300);
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { 
                        key: 'long-issue-key',
                        project: 'test-project',
                        component: 'test-project:file.js',
                        message: longMessage,
                        severity: 'MAJOR',
                        type: 'BUG'
                    }
                ],
                hotspots: []
            });
            
            expect(result.created).to.include('LV-789');
        });

        it('should create tickets for hotspots with proper priority mapping', async () => {
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: 'test-component',
                assignee: 'anoop.mc@gmail.com'
            });
            
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });
            
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(200, { key: 'LV-999' });
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [],
                hotspots: [
                    {
                        key: 'hotspot-key-1',
                        project: 'test-project',
                        component: 'test-project:path/to/file.js',
                        message: 'Hotspot issue',
                        vulnerabilityProbability: 'HIGH'
                    }
                ]
            });
            
            expect(result.created).to.include('LV-999');
        });

        it('should handle Jira search errors gracefully', async () => {
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(500, { message: 'Internal Server Error' });
                
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { 
                        key: 'test-issue-key',
                        project: 'test-project',
                        component: 'test-project:path/to/file.js',
                        message: 'Test issue',
                        severity: 'MAJOR',
                        type: 'BUG'
                    }
                ],
                hotspots: []
            });
            
            // Should still return structure even on errors
            expect(result).to.have.property('created');
            expect(result).to.have.property('existing');
        });

        it('should handle Jira ticket creation errors', async () => {
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: 'test-component',
                assignee: 'anoop.mc@gmail.com'
            });
            
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });
            
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(500, { message: 'Internal Server Error' });
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { 
                        key: 'error-issue-key',
                        project: 'test-project',
                        component: 'test-project:path/to/file.js',
                        message: 'Error issue',
                        severity: 'MAJOR',
                        type: 'BUG'
                    }
                ],
                hotspots: []
            });
            
            // Individual ticket creation errors don't cause the function to return an error
            // The function continues processing and returns the results
            expect(result).to.have.property('created');
            expect(result).to.have.property('existing');
            expect(result.created).to.be.an('array').that.is.empty;
        });

        it('should handle project with empty component', async () => {
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: '',
                assignee: 'anoop.mc@gmail.com'
            });
            
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });
            
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(200, { key: 'LV-NOCOMP' });
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { 
                        key: 'no-comp-issue',
                        project: 'test-project',
                        component: 'test-project:file.js',
                        message: 'No component issue',
                        severity: 'MAJOR',
                        type: 'BUG'
                    }
                ],
                hotspots: []
            });
            
            expect(result.created).to.include('LV-NOCOMP');
        });

        it('should handle custom field assignment errors gracefully', async () => {
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: 'test-component',
                assignee: 'unknown@email.com'
            });
            
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });
            
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .reply(200, { key: 'LV-NOCUSTOM' });
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { 
                        key: 'custom-field-issue',
                        project: 'test-project',
                        component: 'test-project:file.js',
                        message: 'Custom field issue',
                        severity: 'MAJOR',
                        type: 'BUG'
                    }
                ],
                hotspots: []
            });
            
            expect(result.created).to.include('LV-NOCUSTOM');
        });

        it('should handle different severity and vulnerability priority mappings', async () => {
            const getProjectInfoStub = sandbox.stub(require('../../src/utils/functionUtils'), 'getProjectInfo');
            getProjectInfoStub.returns({
                name: 'Test Project',
                component: 'test-component',
                assignee: 'anoop.mc@gmail.com'
            });
            
            nock('https://jira.test')
                .post('/rest/api/3/search')
                .reply(200, { issues: [] });
            
            // Mock multiple ticket creations
            nock('https://jira.test')
                .post('/rest/api/3/issue')
                .times(6)
                .reply(200, (uri, requestBody) => ({ key: `LV-${Math.random().toString(36).substr(2, 9)}` }));
            
            const result = await sonarToJiraService.createJiraTickets({
                issues: [
                    { key: 'critical-issue', project: 'test-project', component: 'test-project:file.js', message: 'Critical', severity: 'CRITICAL', type: 'BUG' },
                    { key: 'major-issue', project: 'test-project', component: 'test-project:file.js', message: 'Major', severity: 'MAJOR', type: 'BUG' },
                    { key: 'minor-issue', project: 'test-project', component: 'test-project:file.js', message: 'Minor', severity: 'MINOR', type: 'BUG' },
                    { key: 'info-issue', project: 'test-project', component: 'test-project:file.js', message: 'Info', severity: 'INFO', type: 'BUG' }
                ],
                hotspots: [
                    { key: 'high-hotspot', project: 'test-project', component: 'test-project:file.js', message: 'High', vulnerabilityProbability: 'HIGH' },
                    { key: 'low-hotspot', project: 'test-project', component: 'test-project:file.js', message: 'Low', vulnerabilityProbability: 'LOW' }
                ]
            });
            
            expect(result.created).to.have.lengthOf(6);
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

        it('should handle API errors and return fallback status', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            // Mock fetchWithRetry to throw an error that will trigger the catch block
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            fetchWithRetryStub.rejects(new Error('API Error'));
            
            const keys = ['k1', 'k2'];
            const result = await _test.checkMultipleIssuesResolved(keys, 'https://sonarqube.test');
            expect(result).to.deep.equal({ k1: false, k2: false });
        });

        it('should handle large batches by splitting requests', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            // Generate 60 keys to test batch splitting (maxBatchSize is 50)
            const keys = Array.from({ length: 60 }, (_, i) => `k${i + 1}`);
            
            // Mock two batch requests
            nock('https://sonarqube.test')
                .get(/\/api\/issues\/search.*/)
                .times(2)
                .reply(200, { issues: [] });
            nock('https://sonarqube.test')
                .get(/\/api\/hotspots\/search.*/)
                .times(2)
                .reply(200, { hotspots: [] });
            
            const result = await _test.checkMultipleIssuesResolved(keys, 'https://sonarqube.test');
            
            // All should be resolved
            keys.forEach(key => {
                expect(result[key]).to.equal(true);
            });
        });
    });

    describe('checkIfIssueResolved', () => {
        it('should use batch check and return correct result', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves({ k1: true });
            
            const result = await _test.checkIfIssueResolved('k1', 'project', 'issue', 'https://sonarqube.test');
            expect(result).to.equal(true);
        });

        it('should return false for undefined result', async () => {
            const { _test } = require('../../src/service/sonar_to_jira_service');
            
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves({});
            
            const result = await _test.checkIfIssueResolved('k1', 'project', 'issue', 'https://sonarqube.test');
            expect(result).to.equal(false);
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
    
    describe('closeResolvedJiraTickets', () => {
        it('should return early when no tickets found', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ issues: [], total: 0 }) 
            });
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result).to.have.property('ticketsChecked', 0);
            expect(result).to.have.property('ticketsClosed', 0);
        });

        it('should handle search API errors', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            fetchWithRetryStub.rejects(new Error('Network error occurred'));
            
            try {
                await sonarToJiraService.closeResolvedJiraTickets();
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Network error occurred');
            }
        });

        it('should handle malformed search response', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ notIssues: 'malformed' }) 
            });
            
            try {
                await sonarToJiraService.closeResolvedJiraTickets();
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Invalid response format');
            }
        });

        it('should handle pagination errors gracefully when tickets already retrieved', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            // First call succeeds with tickets
            fetchWithRetryStub.onFirstCall().resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: [
                        {
                            key: 'LV-100',
                            fields: {
                                summary: 'Test ticket',
                                status: { name: 'Open' },
                                customfield_11972: {
                                    content: [
                                        {
                                            content: [
                                                { text: 'test-sonar-key' }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    ], 
                    total: 200 
                }) 
            });
            
            // Second call fails
            fetchWithRetryStub.onSecondCall().rejects(new Error('Pagination failed'));
            
            // Mock batch resolution check
            const { _test } = require('../../src/service/sonar_to_jira_service');
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves({ 'test-sonar-key': false });
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(1);
        });

        it('should process tickets with resolved SonarQube issues', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            // Mock search response
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: [
                        {
                            key: 'LV-200',
                            fields: {
                                summary: 'Resolved ticket',
                                status: { name: 'Open' },
                                customfield_11972: {
                                    content: [
                                        {
                                            content: [
                                                { text: 'resolved-sonar-key' }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    ], 
                    total: 1 
                }) 
            });
            
            // Mock batch resolution check
            const { _test } = require('../../src/service/sonar_to_jira_service');
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves({ 'resolved-sonar-key': true });
            sandbox.stub(_test, 'closeJiraTicket').resolves(true);
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(1);
            expect(result.ticketsClosed).to.equal(1);
        });

        it('should handle tickets with empty sonar keys', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: [
                        {
                            key: 'LV-300',
                            fields: {
                                summary: 'Empty key ticket',
                                status: { name: 'Open' },
                                customfield_11972: {
                                    content: [
                                        {
                                            content: [
                                                { text: '' }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    ], 
                    total: 1 
                }) 
            });
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(1);
            expect(result.ticketsWithErrors).to.equal(1);
        });

        it('should handle tickets with malformed custom fields', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: [
                        {
                            key: 'LV-400',
                            fields: {
                                summary: 'Malformed ticket',
                                status: { name: 'Open' },
                                customfield_11972: {
                                    content: []
                                }
                            }
                        },
                        {
                            key: 'LV-401',
                            fields: {
                                summary: 'No custom field',
                                status: { name: 'Open' }
                            }
                        }
                    ], 
                    total: 2 
                }) 
            });
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(2);
            expect(result.ticketsWithErrors).to.equal(2);
        });

        it('should handle ticket processing errors', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: [
                        {
                            key: 'LV-500',
                            fields: {
                                summary: 'Error ticket',
                                status: { name: 'Open' },
                                customfield_11972: {
                                    content: [
                                        {
                                            content: [
                                                { text: 'error-sonar-key' }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    ], 
                    total: 1 
                }) 
            });
            
            // Mock batch resolution check to return resolved
            const { _test } = require('../../src/service/sonar_to_jira_service');
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves({ 'error-sonar-key': true });
            sandbox.stub(_test, 'closeJiraTicket').resolves(false); // Close fails
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(1);
            expect(result.ticketsWithErrors).to.equal(1);
            expect(result.ticketsClosed).to.equal(0);
        });

        it('should handle unknown resolution status', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: [
                        {
                            key: 'LV-600',
                            fields: {
                                summary: 'Unknown status ticket',
                                status: { name: 'Open' },
                                customfield_11972: {
                                    content: [
                                        {
                                            content: [
                                                { text: 'unknown-sonar-key' }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    ], 
                    total: 1 
                }) 
            });
            
            // Mock batch resolution check to return undefined status
            const { _test } = require('../../src/service/sonar_to_jira_service');
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves({ 'unknown-sonar-key': undefined });
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(1);
            expect(result.ticketsWithErrors).to.equal(1);
        });

        it('should handle processing with large batches', async () => {
            const fetchWithRetryStub = sandbox.stub(require('../../src/utils/functionUtils'), 'fetchWithRetry');
            
            // Create 10 tickets to test batch processing
            const tickets = Array.from({ length: 10 }, (_, i) => ({
                key: `LV-${i + 700}`,
                fields: {
                    summary: `Batch ticket ${i}`,
                    status: { name: 'Open' },
                    customfield_11972: {
                        content: [
                            {
                                content: [
                                    { text: `batch-sonar-key-${i}` }
                                ]
                            }
                        ]
                    }
                }
            }));
            
            fetchWithRetryStub.resolves({ 
                ok: true, 
                json: async () => ({ 
                    issues: tickets, 
                    total: tickets.length 
                }) 
            });
            
            // Mock resolution check - mark half as resolved
            const { _test } = require('../../src/service/sonar_to_jira_service');
            const resolvedStatus = {};
            tickets.forEach((ticket, i) => {
                resolvedStatus[`batch-sonar-key-${i}`] = i < 5; // First 5 are resolved
            });
            sandbox.stub(_test, 'checkMultipleIssuesResolved').resolves(resolvedStatus);
            sandbox.stub(_test, 'closeJiraTicket').resolves(true);
            
            const result = await sonarToJiraService.closeResolvedJiraTickets();
            expect(result.ticketsChecked).to.equal(10);
            expect(result.ticketsClosed).to.equal(5);
            expect(result.ticketsNotResolved).to.equal(5);
        });
    });

    describe('edge cases and error handling', () => {
        it('should handle missing environment variables in different functions', () => {
            delete process.env.JIRA_BASE_URL;
            
            const { _test } = require('../../src/service/sonar_to_jira_service');
            expect(() => _test.validateEnvironmentVariables())
                .to.throw('Missing required environment variable: JIRA_BASE_URL');
        });

        it('should handle createJiraTickets with missing environment variables', async () => {
            delete process.env.JIRA_USERNAME;
            
            try {
                await sonarToJiraService.createJiraTickets({ issues: [], hotspots: [] });
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Missing required environment variable: JIRA_USERNAME');
            }
        });

        it('should handle closeResolvedJiraTickets with missing environment variables', async () => {
            delete process.env.JIRA_API_TOKEN;
            
            try {
                await sonarToJiraService.closeResolvedJiraTickets();
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Missing required environment variable: JIRA_API_TOKEN');
            }
        });
    });
});