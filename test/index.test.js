const { expect } = require('chai');
const sinon = require('sinon');
const AWS = require('aws-sdk');
const { sonarToJiraHandler } = require('../src/index');
const sonarToJiraService = require('../src/service/sonar_to_jira_service');

describe('Lambda Handler', function() {
  this.timeout(10000);
  
  let consoleLogStub, consoleErrorStub;
  
  beforeEach(() => {
    // Stub console methods to avoid cluttering test output
    consoleLogStub = sinon.stub(console, 'log');
    consoleErrorStub = sinon.stub(console, 'error');
    
    // Set local environment by default
    process.env.AWS_SAM_LOCAL = 'true';
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.PROJECT_FETCHER_FUNCTION = 'ProjectFetcherFunction';
  });
  
  afterEach(() => {
    sinon.restore();
    delete process.env.AWS_SAM_LOCAL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.PROJECT_FETCHER_FUNCTION;
  });

  describe('sonarToJiraHandler', () => {
    it('should return successful response when processing succeeds', async () => {
      // Stub the service methods
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      expect(result.body).to.include('Jira tickets created successfully');
    });
    
    it('should return error response when processing fails', async () => {
      // Stub the service to throw an error
      sinon.stub(sonarToJiraService, 'fetchSonarData').rejects(new Error('Test error'));
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 500);
      expect(result.body).to.include('Failed to process webhook');
      expect(result.body).to.include('Test error');
    });

    it('should handle mixed created and existing tickets', async () => {
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue-1' }, { key: 'test-issue-2' }],
        hotspots: [{ key: 'test-hotspot-1' }]
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123', 'LV-124'],
        existing: ['LV-125']
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      
      const body = JSON.parse(result.body);
      expect(body).to.have.property('message');
      expect(body).to.have.property('summary');
      expect(body.summary).to.have.property('totalCreated', 2);
      expect(body.summary).to.have.property('totalExisting', 1);
      expect(body.summary).to.have.property('totalProcessed', 3);
    });

    it('should handle only existing tickets', async () => {
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: [],
        existing: ['LV-123', 'LV-124']
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      
      const body = JSON.parse(result.body);
      expect(body.message).to.include('already exist');
      expect(body.summary.totalCreated).to.equal(0);
      expect(body.summary.totalExisting).to.equal(2);
    });

    it('should handle no tickets created or existing', async () => {
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: [],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      
      const body = JSON.parse(result.body);
      expect(body.summary.totalCreated).to.equal(0);
      expect(body.summary.totalExisting).to.equal(0);
      expect(body.summary.totalProcessed).to.equal(0);
    });

    it('should run in local environment without Lambda invocation', async () => {
      process.env.AWS_SAM_LOCAL = 'true';
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      expect(result.body).to.include('Jira tickets created successfully');
    });

    it('should run in local environment when AWS_LAMBDA_FUNCTION_NAME is not set', async () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      expect(result.body).to.include('Jira tickets created successfully');
    });

    it('should handle Lambda invocation success in AWS environment', async () => {
      // Set AWS environment
      delete process.env.AWS_SAM_LOCAL; // Ensure it's not set to avoid local detection
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
      
      // Mock AWS Lambda invoke - create mock function that returns the expected structure
      const mockInvoke = sinon.stub().returns({
        promise: () => Promise.resolve({
          StatusCode: 200,
          Payload: JSON.stringify({
            statusCode: 200,
            body: JSON.stringify({
              projects: [{ key: 'test-project', isChecked: true }],
              fallback: false
            })
          })
        })
      });
      
      // Mock the Lambda constructor to return an object with our mocked invoke method
      const mockLambdaInstance = { invoke: mockInvoke };
      sinon.stub(AWS, 'Lambda').returns(mockLambdaInstance);
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      expect(mockInvoke.calledOnce).to.be.true;
    });

    it('should handle Lambda invocation failure', async () => {
      // Set AWS environment
      delete process.env.AWS_SAM_LOCAL; // Ensure it's not set to avoid local detection
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
      
      // Mock AWS Lambda invoke failure
      const mockInvoke = sinon.stub().returns({
        promise: () => Promise.reject(new Error('Lambda invocation failed'))
      });
      
      // Mock the Lambda constructor to return an object with our mocked invoke method
      const mockLambdaInstance = { invoke: mockInvoke };
      sinon.stub(AWS, 'Lambda').returns(mockLambdaInstance);
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
      expect(mockInvoke.calledOnce).to.be.true;
    });

    it('should handle invalid Lambda response', async () => {
      process.env.AWS_SAM_LOCAL = 'false';
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
      
      // Mock AWS Lambda invoke with invalid response
      const mockInvoke = sinon.stub().returns({
        promise: () => Promise.resolve({
          Payload: 'invalid json'
        })
      });
      
      sinon.stub(AWS, 'Lambda').returns({ invoke: mockInvoke });
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
    });

    it('should handle fetchSonarData error', async () => {
      const fetchError = new Error('SonarQube connection failed');
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').rejects(fetchError);
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 500);
      
      const body = JSON.parse(result.body);
      expect(body).to.have.property('error', 'Failed to process webhook');
      expect(body).to.have.property('details', 'SonarQube connection failed');
    });

    it('should handle createJiraTickets error', async () => {
      const createError = new Error('Jira API error');
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').rejects(createError);
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 500);
      
      const body = JSON.parse(result.body);
      expect(body).to.have.property('error', 'Failed to process webhook');
      expect(body).to.have.property('details', 'Jira API error');
    });

    it('should handle missing context', async () => {
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, null);
      
      expect(result).to.have.property('statusCode', 200);
      expect(result.body).to.include('Jira tickets created successfully');
    });

    it('should handle webhook event', async () => {
      const webhookEvent = {
        httpMethod: 'POST',
        body: JSON.stringify({ projectKey: 'test-project' })
      };
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler(webhookEvent, { requestId: 'webhook-123' });
      
      expect(result).to.have.property('statusCode', 200);
      expect(result.body).to.include('Jira tickets created successfully');
    });

    it('should include correct response headers', async () => {
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('headers');
      expect(result.headers).to.have.property('Access-Control-Allow-Origin', '*');
      expect(result.headers).to.have.property('Access-Control-Allow-Headers');
      expect(result.headers).to.have.property('Access-Control-Allow-Methods');
    });

    it('should handle empty project list from Lambda', async () => {
      process.env.AWS_SAM_LOCAL = 'false';
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
      
      const mockInvoke = sinon.stub().returns({
        promise: () => Promise.resolve({
          Payload: JSON.stringify({
            statusCode: 200,
            body: JSON.stringify({
              projects: [],
              fallback: false
            })
          })
        })
      });
      
      sinon.stub(AWS, 'Lambda').returns({ invoke: mockInvoke });
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: [],
        existing: []
      });
      
      const result = await sonarToJiraHandler({}, {});
      
      expect(result).to.have.property('statusCode', 200);
    });

    it('should handle different event types', async () => {
      const events = [
        { httpMethod: 'GET' },
        { httpMethod: 'PUT' },
        { httpMethod: 'DELETE' },
        { source: 'aws.events' }, // CloudWatch event
        {} // Empty event
      ];
      
      sinon.stub(sonarToJiraService, 'fetchSonarData').resolves({
        issues: [{ key: 'test-issue' }],
        hotspots: []
      });
      
      sinon.stub(sonarToJiraService, 'createJiraTickets').resolves({
        created: ['LV-123'],
        existing: []
      });
      
      for (const event of events) {
        const result = await sonarToJiraHandler(event, { requestId: 'test-123' });
        expect(result).to.have.property('statusCode', 200);
      }
    });
  });
});