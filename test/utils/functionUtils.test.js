const { expect } = require('chai');
const sinon = require('sinon');
const nock = require('nock');
const fetch = require('node-fetch');
const { 
    getProjectInfo, 
    processSingleProject, 
    lookupJiraUsers, 
    userAccountCache, 
    fetchWithRetry 
} = require('../../src/utils/functionUtils');
const projectsConfig = require('../../src/utils/projectConfig.json');

describe('Function Utils', function() {
    this.timeout(10000);
    
    beforeEach(() => {
        // Mock environment variables
        process.env.SONARQUBE_BASE_URL = 'https://sonarqube.test';
        process.env.SONARQUBE_TOKEN = 'test-token';
        process.env.JIRA_BASE_URL = 'https://jira.test';
        process.env.JIRA_USERNAME = 'test-user';
        process.env.JIRA_API_TOKEN = 'test-token';
        
        // Clear user cache
        Object.keys(userAccountCache).forEach(key => delete userAccountCache[key]);
        
        nock.disableNetConnect();
    });
    
    afterEach(() => {
        sinon.restore();
        nock.cleanAll();
        nock.enableNetConnect();
    });

    describe('getProjectInfo', () => {
        it('should return project info for existing project', () => {
            const firstProject = projectsConfig.projects[0];
            const result = getProjectInfo(firstProject.key);
            
            expect(result).to.have.property('name', firstProject.name);
            expect(result).to.have.property('assignee', firstProject.assignee);
            expect(result).to.have.property('component', firstProject.component);
        });

        it('should return default values for non-existing project', () => {
            const nonExistentKey = 'non-existent-project';
            const result = getProjectInfo(nonExistentKey);
            
            expect(result).to.have.property('name', nonExistentKey);
            expect(result).to.have.property('assignee', null);
            expect(result).to.have.property('component', 'Others');
        });

        it('should handle empty or null project key', () => {
            const result1 = getProjectInfo('');
            const result2 = getProjectInfo(null);
            
            expect(result1).to.have.property('name', '');
            expect(result1).to.have.property('assignee', null);
            expect(result1).to.have.property('component', 'Others');
            
            expect(result2).to.have.property('name', null);
            expect(result2).to.have.property('assignee', null);
            expect(result2).to.have.property('component', 'Others');
        });

        it('should handle undefined project key', () => {
            const result = getProjectInfo(undefined);
            
            expect(result).to.have.property('name', undefined);
            expect(result).to.have.property('assignee', null);
            expect(result).to.have.property('component', 'Others');
        });

        it('should handle project with missing properties', () => {
            // Temporarily modify config to test edge case
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects.push({
                key: 'incomplete-project',
                name: 'Incomplete Project'
                // Missing assignee and component
            });
            
            const result = getProjectInfo('incomplete-project');
            
            expect(result).to.have.property('name', 'Incomplete Project');
            expect(result).to.have.property('assignee', undefined);
            expect(result).to.have.property('component', undefined);
            
            // Restore original config
            projectsConfig.projects = originalProjects;
        });

        it('should handle project with empty strings for properties', () => {
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects.push({
                key: 'empty-props-project',
                name: 'Empty Props Project',
                assignee: '',
                component: ''
            });
            
            const result = getProjectInfo('empty-props-project');
            
            expect(result).to.have.property('name', 'Empty Props Project');
            expect(result).to.have.property('assignee', '');
            expect(result).to.have.property('component', '');
            
            // Restore original config
            projectsConfig.projects = originalProjects;
        });
    });

    describe('fetchWithRetry', () => {
        it('should return response on successful first attempt', async () => {
            nock('https://example.com')
                .get('/success')
                .reply(200, { message: 'success' });
            
            const response = await fetchWithRetry('https://example.com/success', {});
            
            expect(response.ok).to.be.true;
            expect(response.status).to.equal(200);
        });

        it('should retry on failure and eventually succeed', async () => {
            nock('https://example.com')
                .get('/retry')
                .reply(500, { error: 'server error' })
                .get('/retry')
                .reply(500, { error: 'server error' })
                .get('/retry')
                .reply(200, { message: 'success' });
            
            const response = await fetchWithRetry('https://example.com/retry', {}, 3);
            
            expect(response.ok).to.be.true;
            expect(response.status).to.equal(200);
        });

        it('should throw error after max retries', async () => {
            nock('https://example.com')
                .get('/fail')
                .reply(500, { error: 'server error' })
                .get('/fail')
                .reply(500, { error: 'server error' })
                .get('/fail')
                .reply(500, { error: 'server error' });
            
            try {
                await fetchWithRetry('https://example.com/fail', {}, 3);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('500');
            }
        });

        it('should handle network errors with retry', async () => {
            nock('https://example.com')
                .get('/network-error')
                .replyWithError('Network error')
                .get('/network-error')
                .reply(200, { message: 'success' });
            
            const response = await fetchWithRetry('https://example.com/network-error', {}, 3);
            
            expect(response.ok).to.be.true;
            expect(response.status).to.equal(200);
        });

        it('should use default max retries', async () => {
            nock('https://example.com')
                .get('/default-retries')
                .reply(500)
                .get('/default-retries')
                .reply(500)
                .get('/default-retries')
                .reply(200, { message: 'success' });
            
            const response = await fetchWithRetry('https://example.com/default-retries', {});
            
            expect(response.ok).to.be.true;
            expect(response.status).to.equal(200);
        });

        it('should handle timeout errors', async () => {
            nock('https://example.com')
                .get('/timeout')
                .delay(30000)
                .reply(200, { message: 'success' });
            
            const options = {
                timeout: 1000
            };
            
            try {
                await fetchWithRetry('https://example.com/timeout', options, 1);
                expect.fail('Should have thrown timeout error');
            } catch (error) {
                expect(error.message).to.include('timeout');
            }
        });

        it('should throw error on 4xx status after retries', async () => {
            nock('https://example.com')
                .get('/not-found')
                .reply(404, { error: 'Not found' })
                .get('/not-found')
                .reply(404, { error: 'Not found' })
                .get('/not-found')
                .reply(404, { error: 'Not found' });
            
            try {
                await fetchWithRetry('https://example.com/not-found', {}, 3);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('HTTP 404');
            }
        });

        it('should handle request with custom headers', async () => {
            nock('https://example.com')
                .get('/with-headers')
                .matchHeader('Authorization', 'Bearer token')
                .reply(200, { message: 'success' });
            
            const options = {
                headers: {
                    'Authorization': 'Bearer token'
                }
            };
            
            const response = await fetchWithRetry('https://example.com/with-headers', options);
            
            expect(response.ok).to.be.true;
            expect(response.status).to.equal(200);
        });

        it('should handle POST request with body', async () => {
            nock('https://example.com')
                .post('/with-body', { data: 'test' })
                .reply(200, { message: 'success' });
            
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ data: 'test' })
            };
            
            const response = await fetchWithRetry('https://example.com/with-body', options);
            
            expect(response.ok).to.be.true;
            expect(response.status).to.equal(200);
        });
    });

    describe('processSingleProject', () => {
        it('should process project and fetch issues and hotspots', async () => {
            const projectKey = 'test-project';
            const sonarIssueUrl = 'https://sonarqube.test/api/issues/search';
            const sonarHotspotUrl = 'https://sonarqube.test/api/hotspots/search';
            const sonarToken = 'test-token';
            const sonarPassword = '';
            const allIssues = [];
            const allHotspots = [];
            
            // Mock SonarQube API responses
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query(true)
                .reply(200, {
                    issues: [
                        {
                            key: 'issue-1',
                            project: 'test-project',
                            component: 'test-project:src/file.js',
                            message: 'Test issue',
                            severity: 'MAJOR',
                            type: 'BUG'
                        }
                    ]
                });
            
            nock('https://sonarqube.test')
                .get('/api/hotspots/search')
                .query(true)
                .reply(200, {
                    hotspots: [
                        {
                            key: 'hotspot-1',
                            project: 'test-project',
                            component: 'test-project:src/file.js',
                            message: 'Test hotspot',
                            vulnerabilityProbability: 'HIGH'
                        }
                    ]
                });
            
            await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            
            expect(allIssues).to.have.lengthOf(1);
            expect(allHotspots).to.have.lengthOf(1);
            expect(allIssues[0]).to.have.property('key', 'issue-1');
            expect(allHotspots[0]).to.have.property('key', 'hotspot-1');
        });

        it('should handle API errors gracefully', async () => {
            const projectKey = 'test-project';
            const sonarIssueUrl = 'https://sonarqube.test/api/issues/search';
            const sonarHotspotUrl = 'https://sonarqube.test/api/hotspots/search';
            const sonarToken = 'test-token';
            const sonarPassword = '';
            const allIssues = [];
            const allHotspots = [];
            
            // Mock SonarQube API error responses
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query(true)
                .reply(500, { error: 'Internal Server Error' });
            
            nock('https://sonarqube.test')
                .get('/api/hotspots/search')
                .query(true)
                .reply(500, { error: 'Internal Server Error' });
            
            await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            
            expect(allIssues).to.have.lengthOf(0);
            expect(allHotspots).to.have.lengthOf(0);
        });

        it('should handle missing project key', async () => {
            const projectKey = null;
            const sonarIssueUrl = 'https://sonarqube.test/api/issues/search';
            const sonarHotspotUrl = 'https://sonarqube.test/api/hotspots/search';
            const sonarToken = 'test-token';
            const sonarPassword = '';
            const allIssues = [];
            const allHotspots = [];
            
            await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            
            expect(allIssues).to.have.lengthOf(0);
            expect(allHotspots).to.have.lengthOf(0);
        });

        it('should handle empty response from SonarQube', async () => {
            const projectKey = 'test-project';
            const sonarIssueUrl = 'https://sonarqube.test/api/issues/search';
            const sonarHotspotUrl = 'https://sonarqube.test/api/hotspots/search';
            const sonarToken = 'test-token';
            const sonarPassword = '';
            const allIssues = [];
            const allHotspots = [];
            
            // Mock SonarQube API empty responses
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query(true)
                .reply(200, { issues: [] });
            
            nock('https://sonarqube.test')
                .get('/api/hotspots/search')
                .query(true)
                .reply(200, { hotspots: [] });
            
            await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            
            expect(allIssues).to.have.lengthOf(0);
            expect(allHotspots).to.have.lengthOf(0);
        });

        it('should handle malformed JSON response', async () => {
            const projectKey = 'test-project';
            const sonarIssueUrl = 'https://sonarqube.test/api/issues/search';
            const sonarHotspotUrl = 'https://sonarqube.test/api/hotspots/search';
            const sonarToken = 'test-token';
            const sonarPassword = '';
            const allIssues = [];
            const allHotspots = [];
            
            // Mock SonarQube API malformed responses
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query(true)
                .reply(200, 'invalid json');
            
            nock('https://sonarqube.test')
                .get('/api/hotspots/search')
                .query(true)
                .reply(200, 'invalid json');
            
            await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            
            expect(allIssues).to.have.lengthOf(0);
            expect(allHotspots).to.have.lengthOf(0);
        });

        it('should handle authentication errors', async () => {
            const projectKey = 'test-project';
            const sonarIssueUrl = 'https://sonarqube.test/api/issues/search';
            const sonarHotspotUrl = 'https://sonarqube.test/api/hotspots/search';
            const sonarToken = 'invalid-token';
            const sonarPassword = '';
            const allIssues = [];
            const allHotspots = [];
            
            // Mock SonarQube API authentication errors
            nock('https://sonarqube.test')
                .get('/api/issues/search')
                .query(true)
                .reply(401, { error: 'Unauthorized' });
            
            nock('https://sonarqube.test')
                .get('/api/hotspots/search')
                .query(true)
                .reply(401, { error: 'Unauthorized' });
            
            await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            
            expect(allIssues).to.have.lengthOf(0);
            expect(allHotspots).to.have.lengthOf(0);
        });
    });

    describe('lookupJiraUsers', () => {
        beforeEach(() => {
            // Clear cache before each test
            Object.keys(userAccountCache).forEach(key => delete userAccountCache[key]);
        });

        it('should lookup and cache Jira users', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Mock Jira user search for unique emails from config
            const uniqueEmails = ['test1@example.com', 'test2@example.com'];
            
            // Temporarily modify config to have known emails
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'test1@example.com', isChecked: true },
                { key: 'project2', name: 'Project 2', assignee: 'test2@example.com', isChecked: true },
                { key: 'project3', name: 'Project 3', assignee: 'test1@example.com', isChecked: true } // Duplicate
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'test1@example.com' })
                .reply(200, [{ displayName: 'Test User 1', accountId: 'account1' }]);
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'test2@example.com' })
                .reply(200, [{ displayName: 'Test User 2', accountId: 'account2' }]);
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.have.property('test1@example.com', 'account1');
            expect(userAccountCache).to.have.property('test2@example.com', 'account2');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle user not found', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'notfound@example.com', isChecked: true }
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'notfound@example.com' })
                .reply(200, []);
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.not.have.property('notfound@example.com');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle multiple users with same display name', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'duplicate@example.com', isChecked: true }
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'duplicate@example.com' })
                .reply(200, [
                    { displayName: 'Duplicate User', accountId: 'account1' },
                    { displayName: 'Duplicate User', accountId: 'account2' }
                ]);
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.have.property('duplicate@example.com', 'account1');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle API errors gracefully', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'error@example.com', isChecked: true }
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'error@example.com' })
                .reply(500, { error: 'Internal Server Error' });
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.not.have.property('error@example.com');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should skip users already in cache', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Pre-populate cache
            userAccountCache['cached@example.com'] = 'cached-account';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'cached@example.com', isChecked: true },
                { key: 'project2', name: 'Project 2', assignee: 'new@example.com', isChecked: true }
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'new@example.com' })
                .reply(200, [{ displayName: 'New User', accountId: 'new-account' }]);
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.have.property('cached@example.com', 'cached-account');
            expect(userAccountCache).to.have.property('new@example.com', 'new-account');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle empty project list', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [];
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(Object.keys(userAccountCache)).to.have.lengthOf(0);
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle projects without assignees', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', isChecked: true }, // No assignee
                { key: 'project2', name: 'Project 2', assignee: null, isChecked: true }, // Null assignee
                { key: 'project3', name: 'Project 3', assignee: '', isChecked: true } // Empty assignee
            ];
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(Object.keys(userAccountCache)).to.have.lengthOf(0);
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle network errors', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'test-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'network@example.com', isChecked: true }
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'network@example.com' })
                .replyWithError('Network error');
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.not.have.property('network@example.com');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });

        it('should handle authentication errors', async () => {
            const jiraBaseUrl = 'https://jira.test';
            const jiraUsername = 'test-user';
            const jiraApiToken = 'invalid-token';
            
            // Temporarily modify config
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project1', name: 'Project 1', assignee: 'auth@example.com', isChecked: true }
            ];
            
            nock('https://jira.test')
                .get('/rest/api/3/user/search')
                .query({ query: 'auth@example.com' })
                .reply(401, { error: 'Unauthorized' });
            
            await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
            
            expect(userAccountCache).to.not.have.property('auth@example.com');
            
            // Restore config
            projectsConfig.projects = originalProjects;
        });
    });

    describe('userAccountCache', () => {
        it('should be an object', () => {
            expect(userAccountCache).to.be.an('object');
        });

        it('should be mutable', () => {
            userAccountCache['test@example.com'] = 'test-account';
            expect(userAccountCache).to.have.property('test@example.com', 'test-account');
            delete userAccountCache['test@example.com'];
            expect(userAccountCache).to.not.have.property('test@example.com');
        });

        it('should persist between function calls', () => {
            userAccountCache['persistent@example.com'] = 'persistent-account';
            
            const result = getProjectInfo('test-project');
            
            expect(userAccountCache).to.have.property('persistent@example.com', 'persistent-account');
            delete userAccountCache['persistent@example.com'];
        });
    });
});
