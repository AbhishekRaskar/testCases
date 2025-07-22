const AWS = require("aws-sdk");
const { logger } = require("./microservice.utils");

const secretsManager = new AWS.SecretsManager({
  region: process.env.AWS_REGION || "us-east-1",
});
// Cache for secrets to avoid repeated calls
let secretsCache = null;

/**
 * Determines if the application is running in AWS environment
 * @returns {boolean} True if running in AWS, false if local
 */
function isAWSEnvironment() {
  // Check for AWS Lambda environment, but exclude SAM Local
  // SAM Local sets AWS_SAM_LOCAL=true when running locally
  const isInLambda = !!(
    process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV
  );
  const isSamLocal = process.env.AWS_SAM_LOCAL === "true";

  // Return true only if in Lambda environment but NOT running via SAM Local
  return isInLambda && !isSamLocal;
}

/**
 * Gets environment variables from AWS Secrets Manager
 * @param {string} secretName - Name of the secret in AWS Secrets Manager
 * @returns {Promise<object>} Secret values as key-value pairs
 */
async function getSecretsFromAWS(secretName) {
  try {
    if (secretsCache) {
      logger.debug("💾 Using cached secrets from AWS Secrets Manager");
      return secretsCache;
    }

    logger.info(`🔐 Fetching secrets from AWS Secrets Manager: ${secretName}`);
    // Instantiate AWS.SecretsManager with region for each call
    const secretsManager = new AWS.SecretsManager({
      region: process.env.AWS_REGION || "us-east-1",
    });
    const result = await secretsManager
      .getSecretValue({ SecretId: secretName })
      .promise();

    if (result.SecretString) {
      secretsCache = JSON.parse(result.SecretString);
      logger.success(
        "✅ Successfully retrieved secrets from AWS Secrets Manager"
      );
      return secretsCache;
    } else {
      throw new Error("SecretString not found in AWS Secrets Manager response");
    }
  } catch (error) {
    logger.error(
      `❌ Failed to retrieve secrets from AWS Secrets Manager: ${error.message}`
    );
    throw new Error(`Failed to get secrets from AWS: ${error.message}`);
  }
}

/**
 * Gets environment variables from local .env or process.env
 * @returns {object} Environment variables as key-value pairs
 */
function getSecretsFromLocal() {
  logger.info("🏠 Using local environment variables");

  return {
    SONARQUBE_BASE_URL: process.env.SONARQUBE_BASE_URL,
    SONARQUBE_TOKEN: process.env.SONARQUBE_TOKEN,
    JIRA_BASE_URL: process.env.JIRA_BASE_URL,
    JIRA_USERNAME: process.env.JIRA_USERNAME,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    SONARQUBE_PROJECT_KEY: process.env.SONARQUBE_PROJECT_KEY,
  };
}

/**
 * Gets environment variables based on the environment (AWS or Local)
 * @returns {Promise<object>} Environment variables as key-value pairs
 */
async function getEnvironmentVariables() {
  try {
    if (isAWSEnvironment()) {
      const secretName = "Los-ShardRes-Jira-Scrt";
      if (!secretName) {
        throw new Error(
          "SonarJiraSecretName environment variable not found in AWS environment"
        );
      }
      return await getSecretsFromAWS(secretName);
    } else {
      return getSecretsFromLocal();
    }
  } catch (error) {
    logger.error(`💥 Failed to get environment variables: ${error.message}`);
    throw error;
  }
}

/**
 * Validates that all required environment variables are present
 * @param {object} envVars - Environment variables object
 * @param {string[]} requiredVars - Array of required variable names
 */
function validateEnvironmentVariables(envVars, requiredVars) {
  const missingVars = requiredVars.filter((varName) => !envVars[varName]);

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`
    );
  }

  logger.success(
    `✅ All required environment variables are present (${requiredVars.length} variables)`
  );
}

/**
 * Clears the secrets cache (useful for testing)
 */
function clearSecretsCache() {
  secretsCache = null;
  logger.debug("🗑️  Secrets cache cleared");
}

module.exports = {
  getEnvironmentVariables,
  validateEnvironmentVariables,
  isAWSEnvironment,
  clearSecretsCache,
};
