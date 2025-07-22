process.env.AWS_REGION = "us-east-1"; // Ensure AWS SDK does not throw region error for all tests
const { expect } = require("chai");
const sinon = require("sinon");
const AWS = require("aws-sdk");
AWS.config.update({ region: "us-east-1" }); // Ensure AWS SDK config is set before stubbing
const {
  getEnvironmentVariables,
  validateEnvironmentVariables,
  isAWSEnvironment,
  clearSecretsCache,
} = require("../../src/utils/secrets.utils");

describe("Secrets Utils", function () {
  this.timeout(10000);

  let sandbox;
  let originalEnv;
  let mockSecretsManager;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    // Save original environment
    originalEnv = { ...process.env };
    // Clear secrets cache before each test
    clearSecretsCache();
    // Mock AWS SecretsManager
    mockSecretsManager = {
      getSecretValue: sandbox.stub(),
    };
    sandbox.stub(AWS, "SecretsManager").returns(mockSecretsManager);
  });

  afterEach(() => {
    sandbox.restore();

    // Restore original environment
    process.env = { ...originalEnv };

    // Clear cache after test
    clearSecretsCache();
  });

  describe("isAWSEnvironment", () => {
    it("should return true when AWS_LAMBDA_FUNCTION_NAME is set", () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";
      expect(isAWSEnvironment()).to.be.true;
    });

    it("should return true when AWS_EXECUTION_ENV is set", () => {
      process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x";
      expect(isAWSEnvironment()).to.be.true;
    });

    it("should return false when no AWS environment variables are set", () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      delete process.env.AWS_EXECUTION_ENV;
      expect(isAWSEnvironment()).to.be.false;
    });
  });

  describe("getEnvironmentVariables - Local Environment", () => {
    beforeEach(() => {
      // Ensure we're in local environment
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      delete process.env.AWS_EXECUTION_ENV;
    });

    it("should return local environment variables", async () => {
      process.env.SONARQUBE_BASE_URL = "https://sonar.local";
      process.env.SONARQUBE_TOKEN = "local-token";
      process.env.JIRA_BASE_URL = "https://jira.local";
      process.env.JIRA_USERNAME = "local-user";
      process.env.JIRA_API_TOKEN = "local-api-token";
      process.env.SONARQUBE_PROJECT_KEY = "local-project";
      const result = await getEnvironmentVariables();

      expect(result).to.deep.equal({
        SONARQUBE_BASE_URL: "https://sonar.local",
        SONARQUBE_TOKEN: "local-token",
        JIRA_BASE_URL: "https://jira.local",
        JIRA_USERNAME: "local-user",
        JIRA_API_TOKEN: "local-api-token",
        SONARQUBE_PROJECT_KEY: "local-project",
      });
    });

    it("should handle missing local environment variables", async () => {
      delete process.env.SONARQUBE_BASE_URL;
      delete process.env.SONARQUBE_TOKEN;

      const result = await getEnvironmentVariables();

      expect(result.SONARQUBE_BASE_URL).to.be.undefined;
      expect(result.SONARQUBE_TOKEN).to.be.undefined;
    });
  });

  describe("getEnvironmentVariables - AWS Environment", () => {
    beforeEach(() => {
      // Set AWS environment and region before stubbing
      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";
      process.env.SonarJiraSecretName = "Los-ShardRes-Jira-Scrt";
      process.env.AWS_REGION = "us-east-1";
      AWS.config.update({ region: "us-east-1" });
      // Stub AWS.SecretsManager to always pass region in constructor
      sandbox.restore(); // Remove previous stubs
      sandbox = sinon.createSandbox();
      mockSecretsManager = {
        getSecretValue: sandbox.stub(),
      };
      sandbox.stub(AWS, "SecretsManager").callsFake((opts) => {
        return mockSecretsManager;
      });
    });

    it("should return AWS secrets when in AWS environment", async () => {
      const secretData = {
        SONARQUBE_BASE_URL: "https://sonar.aws",
        SONARQUBE_TOKEN: "aws-token",
        JIRA_BASE_URL: "https://jira.aws",
        JIRA_USERNAME: "aws-user",
        JIRA_API_TOKEN: "aws-api-token",
        SONARQUBE_PROJECT_KEY: "aws-project",
      };

      mockSecretsManager.getSecretValue.returns({
        promise: () =>
          Promise.resolve({
            SecretString: JSON.stringify(secretData),
          }),
      });

      const result = await getEnvironmentVariables();

      expect(result).to.deep.equal(secretData);
      expect(
        mockSecretsManager.getSecretValue.calledWith({
          SecretId: "Los-ShardRes-Jira-Scrt",
        })
      ).to.be.true;
    });

    it("should cache secrets on subsequent calls", async () => {
      const secretData = {
        SONARQUBE_BASE_URL: "https://sonar.aws",
        SONARQUBE_TOKEN: "aws-token",
      };

      mockSecretsManager.getSecretValue.returns({
        promise: () =>
          Promise.resolve({
            SecretString: JSON.stringify(secretData),
          }),
      });

      // First call
      await getEnvironmentVariables();
      // Second call
      await getEnvironmentVariables();

      // Should only call AWS once due to caching
      expect(mockSecretsManager.getSecretValue.calledOnce).to.be.true;
    });

    // it('should throw error when secret name is missing', async () => {
    //     delete process.env.SonarJiraSecretName;

    //     try {
    //         await getEnvironmentVariables();
    //         expect.fail('Should have thrown an error');
    //     } catch (error) {
    //         expect(error.message).to.include('SonarJiraSecretName environment variable not found');
    //     }
    // });

    it("should throw error when AWS secrets manager fails", async () => {
      mockSecretsManager.getSecretValue.returns({
        promise: () => Promise.reject(new Error("AWS Error")),
      });

      try {
        await getEnvironmentVariables();
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("Failed to get secrets from AWS");
      }
    });

    it("should throw error when SecretString is missing", async () => {
      mockSecretsManager.getSecretValue.returns({
        promise: () => Promise.resolve({}),
      });

      try {
        await getEnvironmentVariables();
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("SecretString not found");
      }
    });
  });

  describe("validateEnvironmentVariables", () => {
    it("should not throw when all required variables are present", () => {
      const envVars = {
        SONARQUBE_BASE_URL: "https://sonar.test",
        SONARQUBE_TOKEN: "token",
        JIRA_BASE_URL: "https://jira.test",
        JIRA_USERNAME: "user",
        JIRA_API_TOKEN: "api-token",
      };
      const requiredVars = [
        "SONARQUBE_BASE_URL",
        "SONARQUBE_TOKEN",
        "JIRA_BASE_URL",
        "JIRA_USERNAME",
        "JIRA_API_TOKEN",
      ];

      expect(() =>
        validateEnvironmentVariables(envVars, requiredVars)
      ).to.not.throw();
    });

    it("should throw error when required variables are missing", () => {
      const envVars = {
        SONARQUBE_BASE_URL: "https://sonar.test",
        JIRA_BASE_URL: "https://jira.test",
      };
      const requiredVars = [
        "SONARQUBE_BASE_URL",
        "SONARQUBE_TOKEN",
        "JIRA_BASE_URL",
        "JIRA_USERNAME",
        "JIRA_API_TOKEN",
      ];

      expect(() =>
        validateEnvironmentVariables(envVars, requiredVars)
      ).to.throw(
        "Missing required environment variables: SONARQUBE_TOKEN, JIRA_USERNAME, JIRA_API_TOKEN"
      );
    });

    it("should handle empty environment variables object", () => {
      const envVars = {};
      const requiredVars = ["SONARQUBE_BASE_URL", "SONARQUBE_TOKEN"];

      expect(() =>
        validateEnvironmentVariables(envVars, requiredVars)
      ).to.throw(
        "Missing required environment variables: SONARQUBE_BASE_URL, SONARQUBE_TOKEN"
      );
    });

    it("should handle empty required variables array", () => {
      const envVars = { SOME_VAR: "value" };
      const requiredVars = [];

      expect(() =>
        validateEnvironmentVariables(envVars, requiredVars)
      ).to.not.throw();
    });
  });

  describe("clearSecretsCache", () => {
    it("should clear the internal cache", async () => {
      // Set AWS environment and region before stubbing
      process.env.AWS_LAMBDA_FUNCTION_NAME = "test-function";
      process.env.SonarJiraSecretName = "test-secret";
      process.env.AWS_REGION = "us-east-1";
      AWS.config.update({ region: "us-east-1" });
      sandbox.restore(); // Remove previous stubs
      sandbox = sinon.createSandbox();
      mockSecretsManager = {
        getSecretValue: sandbox.stub(),
      };
      sandbox.stub(AWS, "SecretsManager").callsFake((opts) => {
        return mockSecretsManager;
      });
      const secretData = { SONARQUBE_BASE_URL: "https://sonar.aws" };
      mockSecretsManager.getSecretValue.returns({
        promise: () =>
          Promise.resolve({
            SecretString: JSON.stringify(secretData),
          }),
      });
      // First call - should hit AWS
      await getEnvironmentVariables();
      expect(mockSecretsManager.getSecretValue.calledOnce).to.be.true;
      // Clear cache
      clearSecretsCache();
      // Second call - should hit AWS again since cache is cleared
      await getEnvironmentVariables();
      expect(mockSecretsManager.getSecretValue.calledTwice).to.be.true;
    });
  });
});
