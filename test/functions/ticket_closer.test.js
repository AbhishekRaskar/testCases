const { expect } = require('chai');
const sinon = require('sinon');
const { ticketCloserHandler } = require('../../src/functions/ticket_closer');
const sonarToJiraService = require('../../src/service/sonar_to_jira_service');

describe('Ticket Closer Handler', () => {
    let consoleLogStub, consoleErrorStub;
    
    beforeEach(() => {
        // Set up required environment variables for testing
        process.env.SONARQUBE_BASE_URL = 'https://sonarqube.test';
        process.env.SONARQUBE_TOKEN = 'test-token';
        process.env.JIRA_BASE_URL = 'https://jira.test';
        process.env.JIRA_USERNAME = 'test-user';
        process.env.JIRA_API_TOKEN = 'test-token';
        
        // Stub console methods to avoid cluttering test output
        consoleLogStub = sinon.stub(console, 'log');
        consoleErrorStub = sinon.stub(console, 'error');
    });
    
    afterEach(() => {
        // Clean up environment variables
        delete process.env.SONARQUBE_BASE_URL;
        delete process.env.SONARQUBE_TOKEN;
        delete process.env.JIRA_BASE_URL;
        delete process.env.JIRA_USERNAME;
        delete process.env.JIRA_API_TOKEN;
        
        sinon.restore();
    });

    describe('ticketCloserHandler', () => {
        it('should successfully close resolved tickets', async () => {
            const mockResult = {
                ticketsChecked: 50,
                ticketsClosed: 5,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = { httpMethod: 'POST' };
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.have.property('summary');
            expect(body.message).to.include('Successfully processed 50 tickets');
            expect(body.message).to.include('closed 5 resolved tickets');
            expect(body.summary).to.deep.equal(mockResult);
            
            expect(stubCloseResolvedJiraTickets.calledOnce).to.be.true;
        });

        it('should handle zero tickets closed', async () => {
            const mockResult = {
                ticketsChecked: 30,
                ticketsClosed: 0,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body.message).to.include('Successfully processed 30 tickets');
            expect(body.message).to.include('closed 0 resolved tickets');
            expect(body.summary).to.deep.equal(mockResult);
        });

        it('should handle service errors', async () => {
            const mockError = new Error('Service error occurred');
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .rejects(mockError);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 500);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('error', 'Failed to process ticket closing');
            expect(body).to.have.property('details', 'Service error occurred');
            expect(body).to.have.property('timestamp');
            
            expect(stubCloseResolvedJiraTickets.calledOnce).to.be.true;
        });

        it('should handle scheduled events', async () => {
            const mockResult = {
                ticketsChecked: 25,
                ticketsClosed: 3,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = {}; // Scheduled event (no httpMethod)
            const mockContext = { requestId: 'scheduled-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.have.property('summary');
            expect(body.summary).to.deep.equal(mockResult);
        });

        it('should handle large number of tickets', async () => {
            const mockResult = {
                ticketsChecked: 1000,
                ticketsClosed: 150,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = { httpMethod: 'POST' };
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body.message).to.include('Successfully processed 1000 tickets');
            expect(body.message).to.include('closed 150 resolved tickets');
            expect(body.summary.ticketsChecked).to.equal(1000);
            expect(body.summary.ticketsClosed).to.equal(150);
        });

        it('should handle missing context', async () => {
            const mockResult = {
                ticketsChecked: 10,
                ticketsClosed: 2,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = {};
            const mockContext = null;
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.have.property('summary');
        });

        it('should include correct response headers', async () => {
            const mockResult = {
                ticketsChecked: 5,
                ticketsClosed: 1,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('headers');
            expect(result.headers).to.have.property('Access-Control-Allow-Origin', '*');
            expect(result.headers).to.have.property('Access-Control-Allow-Headers');
            expect(result.headers).to.have.property('Access-Control-Allow-Methods');
        });

        it('should handle result with errors', async () => {
            const mockResult = {
                ticketsChecked: 20,
                ticketsClosed: 3,
                errors: ['Error 1', 'Error 2']
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 200);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('message');
            expect(body).to.have.property('summary');
            expect(body.summary.errors).to.have.lengthOf(2);
            expect(body.summary.errors).to.include('Error 1');
            expect(body.summary.errors).to.include('Error 2');
        });

        it('should handle timeout errors', async () => {
            const timeoutError = new Error('Request timeout');
            timeoutError.name = 'TimeoutError';
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .rejects(timeoutError);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 500);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('error', 'Failed to process ticket closing');
            expect(body).to.have.property('details', 'Request timeout');
            expect(body).to.have.property('timestamp');
        });

        it('should handle undefined result from service', async () => {
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(undefined);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 500);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('error', 'Failed to process ticket closing');
            expect(body).to.have.property('details');
        });

        it('should handle null result from service', async () => {
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(null);
            
            const mockEvent = {};
            const mockContext = { requestId: 'test-request-id' };
            
            const result = await ticketCloserHandler(mockEvent, mockContext);
            
            expect(result).to.have.property('statusCode', 500);
            
            const body = JSON.parse(result.body);
            expect(body).to.have.property('error', 'Failed to process ticket closing');
            expect(body).to.have.property('details');
        });

        it('should handle different HTTP methods', async () => {
            const mockResult = {
                ticketsChecked: 15,
                ticketsClosed: 4,
                errors: []
            };
            
            const stubCloseResolvedJiraTickets = sinon.stub(sonarToJiraService, 'closeResolvedJiraTickets')
                .resolves(mockResult);
            
            const httpMethods = ['GET', 'POST', 'PUT', 'DELETE'];
            
            for (const method of httpMethods) {
                const mockEvent = { httpMethod: method };
                const mockContext = { requestId: 'test-request-id' };
                
                const result = await ticketCloserHandler(mockEvent, mockContext);
                
                expect(result).to.have.property('statusCode', 200);
                
                const body = JSON.parse(result.body);
                expect(body).to.have.property('message');
                expect(body).to.have.property('summary');
            }
        });
    });
});
