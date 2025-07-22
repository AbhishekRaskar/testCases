const { expect } = require("chai");

const sinon = require("sinon");

const AWS = require("aws-sdk");

const { sonarToJiraHandler } = require("../src/index");

const sonarToJiraService = require("../src/service/sonar_to_jira_service");

describe("Lambda Handler", function () {
  this.timeout(10000);

  let consoleLogStub, consoleErrorStub;

  beforeEach(() => {
    // Stub console methods to avoid cluttering test output

    consoleLogStub = sinon.stub(console, "log");

    consoleErrorStub = sinon.stub(console, "error");

    // Set local environment by default

    process.env.AWS_SAM_LOCAL = "true";

    delete process.env.AWS_LAMBDA_FUNCTION_NAME;

    process.env.PROJECT_FETCHER_FUNCTION = "ProjectFetcherFunction";
  });

  afterEach(() => {
    sinon.restore();

    delete process.env.AWS_SAM_LOCAL;

    delete process.env.AWS_LAMBDA_FUNCTION_NAME;

    delete process.env.PROJECT_FETCHER_FUNCTION;
  });

  describe("sonarToJiraHandler", () => {
    it("should return successful response when processing succeeds", async () => {
      // Stub the service methods

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");
    });

    it("should return error response when processing fails", async () => {
      // Stub the service to throw an error

      sinon
        .stub(sonarToJiraService, "fetchSonarData")
        .rejects(new Error("Test error"));

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 500);

      expect(result.body).to.include("Failed to process webhook");

      expect(result.body).to.include("Test error");
    });

    it("should handle mixed created and existing tickets", async () => {
      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue-1" }, { key: "test-issue-2" }],

        hotspots: [{ key: "test-hotspot-1" }],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123", "LV-124"],

        existing: ["LV-125"],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 200);

      const body = JSON.parse(result.body);

      expect(body).to.have.property("message");

      expect(body).to.have.property("summary");

      expect(body.summary).to.have.property("totalCreated", 2);

      expect(body.summary).to.have.property("totalExisting", 1);

      expect(body.summary).to.have.property("totalProcessed", 3);
    });

    it("should handle only existing tickets", async () => {
      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: [],

        existing: ["LV-123", "LV-124"],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 200);

      const body = JSON.parse(result.body);

      expect(body.message).to.include("already exist");

      expect(body.summary.totalCreated).to.equal(0);

      expect(body.summary.totalExisting).to.equal(2);
    });

    it("should handle no tickets created or existing", async () => {
      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: [],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 200);

      const body = JSON.parse(result.body);

      expect(body.summary.totalCreated).to.equal(0);

      expect(body.summary.totalExisting).to.equal(0);

      expect(body.summary.totalProcessed).to.equal(0);
    });

    it("should run in local environment without Lambda invocation", async () => {
      process.env.AWS_SAM_LOCAL = "true";

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");
    });

    it("should run in local environment when AWS_LAMBDA_FUNCTION_NAME is not set", async () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");
    });

    it("should handle fetchSonarData error", async () => {
      const fetchError = new Error("SonarQube connection failed");

      sinon.stub(sonarToJiraService, "fetchSonarData").rejects(fetchError);

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 500);

      const body = JSON.parse(result.body);

      expect(body).to.have.property("error", "Failed to process webhook");

      expect(body).to.have.property("details", "SonarQube connection failed");
    });

    it("should handle createJiraTickets error", async () => {
      const createError = new Error("Jira API error");

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").rejects(createError);

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("statusCode", 500);

      const body = JSON.parse(result.body);

      expect(body).to.have.property("error", "Failed to process webhook");

      expect(body).to.have.property("details", "Jira API error");
    });

    it("should handle missing context", async () => {
      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, null);

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");
    });

    it("should handle webhook event", async () => {
      const webhookEvent = {
        httpMethod: "POST",

        body: JSON.stringify({ projectKey: "test-project" }),
      };

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler(webhookEvent, {
        requestId: "webhook-123",
      });

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");
    });

    it("should include correct response headers", async () => {
      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, {});

      expect(result).to.have.property("headers");

      expect(result.headers).to.have.property(
        "Access-Control-Allow-Origin",
        "*"
      );

      expect(result.headers).to.have.property("Access-Control-Allow-Headers");

      expect(result.headers).to.have.property("Access-Control-Allow-Methods");
    });

    it("should handle different event types", async () => {
      const events = [
        { httpMethod: "GET" },

        { httpMethod: "PUT" },

        { httpMethod: "DELETE" },

        { source: "aws.events" }, // CloudWatch event

        {}, // Empty event
      ];

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      for (const event of events) {
        const result = await sonarToJiraHandler(event, {
          requestId: "test-123",
        });

        expect(result).to.have.property("statusCode", 200);
      }
    });

    it("should handle Lambda invocation in AWS environment with successful response", async () => {
      // Set AWS environment - remove local indicators

      delete process.env.AWS_SAM_LOCAL;

      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";

      process.env.SonarJiraSecretName = "test-secret";

      // Mock AWS.SecretsManager

      const mockSecretsManager = {
        getSecretValue: sinon.stub().returns({
          promise: sinon.stub().resolves({
            SecretString: JSON.stringify({
              SONARQUBE_BASE_URL: "https://sonarqube.test",

              SONARQUBE_TOKEN: "test-token",

              JIRA_BASE_URL: "https://jira.test",

              JIRA_USERNAME: "test-user",

              JIRA_API_TOKEN: "test-token",
            }),
          }),
        }),
      };

      sinon.stub(AWS, "SecretsManager").returns(mockSecretsManager);

      // Mock AWS Lambda invoke with successful response

      const mockLambda = {
        invoke: sinon.stub().returns({
          promise: sinon.stub().resolves({
            StatusCode: 200,

            Payload: JSON.stringify({
              statusCode: 200,

              body: JSON.stringify({
                projects: [{ key: "test-project", name: "Test Project" }],
              }),
            }),
          }),
        }),
      };

      sinon.stub(AWS, "Lambda").returns(mockLambda);

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, { requestId: "lambda-test" });

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");

      expect(mockLambda.invoke.calledOnce).to.be.true;
    });

    it("should handle Lambda invocation with error response", async () => {
      // Set AWS environment - remove local indicators

      delete process.env.AWS_SAM_LOCAL;

      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";

      process.env.SonarJiraSecretName = "test-secret";

      // Mock AWS.SecretsManager

      const mockSecretsManager = {
        getSecretValue: sinon.stub().returns({
          promise: sinon.stub().resolves({
            SecretString: JSON.stringify({
              SONARQUBE_BASE_URL: "https://sonarqube.test",

              SONARQUBE_TOKEN: "test-token",

              JIRA_BASE_URL: "https://jira.test",

              JIRA_USERNAME: "test-user",

              JIRA_API_TOKEN: "test-token",
            }),
          }),
        }),
      };

      sinon.stub(AWS, "SecretsManager").returns(mockSecretsManager);

      // Mock AWS Lambda invoke with error response

      const mockLambda = {
        invoke: sinon.stub().returns({
          promise: sinon.stub().resolves({
            StatusCode: 200,

            Payload: JSON.stringify({
              statusCode: 500,

              body: JSON.stringify({
                error: "Project fetcher failed",
              }),
            }),
          }),
        }),
      };

      sinon.stub(AWS, "Lambda").returns(mockLambda);

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, { requestId: "lambda-test" });

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");

      expect(mockLambda.invoke.calledOnce).to.be.true;
    });

    it("should handle batch processing for large project lists", async () => {
      // Set AWS environment - remove local indicators

      delete process.env.AWS_SAM_LOCAL;

      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";

      process.env.SonarJiraSecretName = "test-secret";

      // Mock AWS.SecretsManager

      const mockSecretsManager = {
        getSecretValue: sinon.stub().returns({
          promise: sinon.stub().resolves({
            SecretString: JSON.stringify({
              SONARQUBE_BASE_URL: "https://sonarqube.test",

              SONARQUBE_TOKEN: "test-token",

              JIRA_BASE_URL: "https://jira.test",

              JIRA_USERNAME: "test-user",

              JIRA_API_TOKEN: "test-token",
            }),
          }),
        }),
      };

      sinon.stub(AWS, "SecretsManager").returns(mockSecretsManager);

      // Create a large project list (more than 10 projects)

      const projects = [];

      for (let i = 1; i <= 12; i++) {
        projects.push({ key: `project-${i}`, name: `Project ${i}` });
      }

      // Mock AWS Lambda invoke with large project list

      const mockLambda = {
        invoke: sinon.stub().returns({
          promise: sinon.stub().resolves({
            StatusCode: 200,

            Payload: JSON.stringify({
              statusCode: 200,

              body: JSON.stringify({
                projects: projects,
              }),
            }),
          }),
        }),
      };

      sinon.stub(AWS, "Lambda").returns(mockLambda);

      // Mock sonar service calls for batch processing

      const fetchSonarDataStub = sinon.stub(
        sonarToJiraService,
        "fetchSonarData"
      );

      fetchSonarDataStub.resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      const createJiraTicketsStub = sinon.stub(
        sonarToJiraService,
        "createJiraTickets"
      );

      createJiraTicketsStub.resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, { requestId: "batch-test" });

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");

      expect(mockLambda.invoke.calledOnce).to.be.true;

      // Should have called fetchSonarData multiple times for batching

      expect(fetchSonarDataStub.callCount).to.be.greaterThan(1);

      expect(createJiraTicketsStub.callCount).to.be.greaterThan(1);
    });

    it("should handle Lambda invocation returning error response payload", async () => {
      // Set AWS environment - remove local indicators

      delete process.env.AWS_SAM_LOCAL;

      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";

      process.env.SonarJiraSecretName = "test-secret";

      // Mock AWS.SecretsManager

      const mockSecretsManager = {
        getSecretValue: sinon.stub().returns({
          promise: sinon.stub().resolves({
            SecretString: JSON.stringify({
              SONARQUBE_BASE_URL: "https://sonarqube.test",

              SONARQUBE_TOKEN: "test-token",

              JIRA_BASE_URL: "https://jira.test",

              JIRA_USERNAME: "test-user",

              JIRA_API_TOKEN: "test-token",
            }),
          }),
        }),
      };

      sinon.stub(AWS, "SecretsManager").returns(mockSecretsManager);

      // Mock AWS Lambda invoke with error response payload (statusCode !== 200)

      const mockLambda = {
        invoke: sinon.stub().returns({
          promise: sinon.stub().resolves({
            StatusCode: 200,

            Payload: JSON.stringify({
              statusCode: 500, // This triggers the error handling in lines 65-68

              body: JSON.stringify({
                error: "Project fetcher failed",
              }),
            }),
          }),
        }),
      };

      sinon.stub(AWS, "Lambda").returns(mockLambda);

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [{ key: "test-issue" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, { requestId: "lambda-test" });

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");

      expect(mockLambda.invoke.calledOnce).to.be.true;
    });

    it("should handle batch processing error and continue with next batch", async () => {
      // Set AWS environment - remove local indicators

      delete process.env.AWS_SAM_LOCAL;

      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";

      process.env.SonarJiraSecretName = "test-secret";

      // Mock AWS.SecretsManager

      const mockSecretsManager = {
        getSecretValue: sinon.stub().returns({
          promise: sinon.stub().resolves({
            SecretString: JSON.stringify({
              SONARQUBE_BASE_URL: "https://sonarqube.test",

              SONARQUBE_TOKEN: "test-token",

              JIRA_BASE_URL: "https://jira.test",

              JIRA_USERNAME: "test-user",

              JIRA_API_TOKEN: "test-token",
            }),
          }),
        }),
      };

      sinon.stub(AWS, "SecretsManager").returns(mockSecretsManager);

      // Create a large project list (more than 10 projects) to trigger batch processing

      const projects = [];

      for (let i = 1; i <= 12; i++) {
        projects.push({ key: `project-${i}`, name: `Project ${i}` });
      }

      // Mock AWS Lambda invoke with large project list

      const mockLambda = {
        invoke: sinon.stub().returns({
          promise: sinon.stub().resolves({
            StatusCode: 200,

            Payload: JSON.stringify({
              statusCode: 200,

              body: JSON.stringify({
                projects: projects,
              }),
            }),
          }),
        }),
      };

      sinon.stub(AWS, "Lambda").returns(mockLambda);

      // Mock service functions - first batch fails to test error handling

      const fetchSonarDataStub = sinon.stub(
        sonarToJiraService,
        "fetchSonarData"
      );

      fetchSonarDataStub.onFirstCall().rejects(new Error("First batch failed")); // This triggers line 134

      fetchSonarDataStub.onSecondCall().resolves({
        issues: [{ key: "test-issue-2" }],

        hotspots: [],
      });

      fetchSonarDataStub.onThirdCall().resolves({
        issues: [{ key: "test-issue-3" }],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, { requestId: "batch-test" });

      expect(result).to.have.property("statusCode", 200);

      expect(result.body).to.include("Jira tickets created successfully");

      expect(mockLambda.invoke.calledOnce).to.be.true;

      // Should have called fetchSonarData 3 times (1 failure + 2 successes)

      expect(fetchSonarDataStub.callCount).to.equal(3);
    });

    it("should handle Lambda invocation with non-200 status code", async () => {
      // Setup AWS environment

      delete process.env.AWS_SAM_LOCAL;

      process.env.AWS_LAMBDA_FUNCTION_NAME = "SonarToJiraHandler";

      process.env.SonarJiraSecretName = "test-secret";

      // Mock SecretsManager

      const mockSecretsManager = {
        getSecretValue: sinon.stub().returns({
          promise: sinon.stub().resolves({
            SecretString: JSON.stringify({
              SONARQUBE_BASE_URL: "https://sonarqube.test",

              SONARQUBE_TOKEN: "test-token",

              JIRA_BASE_URL: "https://jira.test",

              JIRA_USERNAME: "test-user",

              JIRA_API_TOKEN: "test-token",
            }),
          }),
        }),
      };

      sinon.stub(AWS, "SecretsManager").returns(mockSecretsManager);

      // Mock Lambda with non-200 status code

      const mockLambda = {
        invoke: sinon.stub().returns({
          promise: sinon.stub().resolves({
            StatusCode: 400, // Non-200 status code
          }),
        }),
      };

      sinon.stub(AWS, "Lambda").returns(mockLambda);

      // Mock service functions for fallback

      sinon.stub(sonarToJiraService, "fetchSonarData").resolves({
        issues: [
          {
            key: "TEST-1",
            message: "Test issue",
            assignee: "test@example.com",
          },
        ],

        hotspots: [],
      });

      sinon.stub(sonarToJiraService, "createJiraTickets").resolves({
        created: ["LV-123"],

        existing: [],
      });

      const result = await sonarToJiraHandler({}, { requestId: "test" });

      expect(result.statusCode).to.equal(200);

      expect(result.body).to.include("Jira tickets created successfully");
    });
  });
});
