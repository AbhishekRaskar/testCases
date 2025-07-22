const { expect } = require('chai');
const sinon = require('sinon');
const { projectFetcherHandler } = require('../../src/functions/project_fetcher');
const projectsConfig = require('../../src/utils/projectConfig.json');

describe('Project Fetcher Handler', () => {
    let consoleLogStub, consoleErrorStub;
    
    beforeEach(() => {
        // Stub console methods to avoid cluttering test output
        consoleLogStub = sinon.stub(console, 'log');
        consoleErrorStub = sinon.stub(console, 'error');
    });
    
    afterEach(() => {
        sinon.restore();
    });

    describe('projectFetcherHandler', () => {
        it('should return enabled projects from config', async () => {
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('projects');
            expect(body).to.have.property('fallback', false);
            expect(body).to.have.property('message');
            expect(body.projects).to.be.an('array');
            
            // Check that all returned projects are enabled
            body.projects.forEach(project => {
                expect(project).to.have.property('isChecked', true);
                expect(project).to.have.property('key');
            });
        });

        it('should return fallback project when no enabled projects and env var is set', async () => {
            // Temporarily disable all projects
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects.forEach(project => {
                project.isChecked = false;
            });
            
            // Set environment variable
            process.env.SONARQUBE_PROJECT_KEY = 'fallback-project';
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('projects');
            expect(body).to.have.property('fallback', true);
            expect(body).to.have.property('message', 'Using environment fallback project');
            expect(body.projects).to.have.lengthOf(1);
            expect(body.projects[0]).to.deep.equal({
                key: 'fallback-project',
                isChecked: true
            });
            
            // Restore original config
            projectsConfig.projects = originalProjects;
            delete process.env.SONARQUBE_PROJECT_KEY;
        });

        it('should return empty array when no enabled projects and no env var', async () => {
            // Temporarily disable all projects
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects.forEach(project => {
                project.isChecked = false;
            });
            
            // Ensure env var is not set
            delete process.env.SONARQUBE_PROJECT_KEY;
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('projects');
            expect(body).to.have.property('fallback', false);
            expect(body).to.have.property('message', 'No active projects found');
            expect(body.projects).to.be.an('array').that.is.empty;
            
            // Restore original config
            projectsConfig.projects = originalProjects;
        });

        it('should handle missing projects array in config', async () => {
            // Temporarily remove projects array
            const originalProjects = projectsConfig.projects;
            delete projectsConfig.projects;
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('projects');
            expect(body.projects).to.be.an('array').that.is.empty;
            
            // Restore original config
            projectsConfig.projects = originalProjects;
        });

        it('should filter out projects without keys', async () => {
            // Temporarily add projects without keys
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { name: 'Project 1', isChecked: true }, // No key
                { key: 'project-2', name: 'Project 2', isChecked: true }, // Valid
                { key: '', name: 'Project 3', isChecked: true }, // Empty key
                { key: 'project-4', name: 'Project 4', isChecked: true } // Valid
            ];
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body.projects).to.have.lengthOf(2);
            expect(body.projects[0]).to.have.property('key', 'project-2');
            expect(body.projects[1]).to.have.property('key', 'project-4');
            
            // Restore original config
            projectsConfig.projects = originalProjects;
        });

        it('should handle projects with only isChecked: false', async () => {
            // Temporarily set all projects to disabled
            const originalProjects = [...projectsConfig.projects];
            projectsConfig.projects = [
                { key: 'project-1', name: 'Project 1', isChecked: false },
                { key: 'project-2', name: 'Project 2', isChecked: false },
                { key: 'project-3', name: 'Project 3', isChecked: false }
            ];
            
            delete process.env.SONARQUBE_PROJECT_KEY;
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body.projects).to.be.an('array').that.is.empty;
            expect(body.fallback).to.be.false;
            expect(body.message).to.equal('No active projects found');
            
            // Restore original config
            projectsConfig.projects = originalProjects;
        });

        it('should handle error scenarios', async () => {
            // Force an error by simulating a JSON parsing error
            const originalProjects = projectsConfig.projects;
            
            try {
                // Create a scenario that will actually cause an error
                // by making the projects property access throw
                Object.defineProperty(projectsConfig, 'projects', {
                    get: () => { throw new Error('Configuration access error'); },
                    configurable: true
                });
                
                const mockEvent = {};
                const mockContext = { requestId: 'test-request-id' };
                
                const result = await projectFetcherHandler(mockEvent, mockContext);
                
                expect(result).to.have.property('statusCode', 500);
                
                const body = JSON.parse(result.body);
                expect(body).to.have.property('error', 'Failed to fetch projects');
                expect(body).to.have.property('details');
                expect(body).to.have.property('projects');
                expect(body.projects).to.be.an('array').that.is.empty;
            } finally {
                // Restore original config
                Object.defineProperty(projectsConfig, 'projects', {
                    value: originalProjects,
                    writable: true,
                    configurable: true
                });
            }
        });

        it('should handle missing context', async () => {
            const mockEvent = {};
            const mockContext = null;
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('projects');
            expect(body.projects).to.be.an('array');
        });

        it('should include correct response headers', async () => {
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('headers');
            expect(result.headers).to.have.property('Access-Control-Allow-Origin', '*');
            expect(result.headers).to.have.property('Access-Control-Allow-Headers');
            expect(result.headers).to.have.property('Access-Control-Allow-Methods');
        });

        it('should return projects with all required properties', async () => {
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await projectFetcherHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            const enabledProjects = body.projects;
            
            enabledProjects.forEach(project => {
                expect(project).to.have.property('key');
                expect(project).to.have.property('isChecked', true);
                expect(project.key).to.be.a('string');
                expect(project.key).to.not.be.empty;
            });
        });

        it('should handle mixed enabled/disabled projects correctly', async () => {
            // Set up a mix of enabled and disabled projects
            const originalProjects = JSON.parse(JSON.stringify(projectsConfig.projects));
            
            try {
                projectsConfig.projects = [
                    { key: 'enabled-1', name: 'Enabled 1', isChecked: true },
                    { key: 'disabled-1', name: 'Disabled 1', isChecked: false },
                    { key: 'enabled-2', name: 'Enabled 2', isChecked: true },
                    { key: 'disabled-2', name: 'Disabled 2', isChecked: false }
                ];
                
                const mockEvent = {};
                const mockContext = { requestId: 'test-request-id' };
                
                const result = await projectFetcherHandler(mockEvent, mockContext);
                
                expect(result).to.have.property('statusCode', 200);
                
                const body = JSON.parse(result.body);
                expect(body.projects).to.have.lengthOf(2);
                expect(body.projects[0]).to.have.property('key', 'enabled-1');
                expect(body.projects[1]).to.have.property('key', 'enabled-2');
            } finally {
                // Restore original config
                projectsConfig.projects = originalProjects;
            }
        });
    });
});
