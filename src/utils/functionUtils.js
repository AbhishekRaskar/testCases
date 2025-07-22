const fetch = require("node-fetch");
const projectsConfig = require("./projectConfig.json");
const { CONFIG } = require("../constants/constant");
const { logger } = require("./microservice.utils");

/**
 * Fetch with automatic retry functionality
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Response>} - Fetch response
 */
const fetchWithRetry = async (url, options, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (i === maxRetries - 1) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      logger.warn(`🔄 Retry attempt ${i + 1}/${maxRetries} for ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
};

// Get project name, assignee and component from key
function getProjectInfo(projectKey) {
  const project = projectsConfig.projects.find((p) => p.key === projectKey);
  return {
    name: project ? project.name : projectKey,
    assignee: project ? project.assignee : null,
    component: project ? project.component : "Others",
  };
}

// Process a single SonarQube project
async function processSingleProject(
  projectKey,
  sonarIssueUrl,
  sonarHotspotUrl,
  sonarToken,
  sonarPassword,
  allIssues,
  allHotspots
) {
  logger.debug(`🔍 Starting analysis for project: ${projectKey}`);

  // Fetch issues for this project
  const issueParams = new URLSearchParams({
    componentKeys: projectKey,
    resolved: CONFIG.SONARQUBE.ISSUE_FILTERS.RESOLVED,
    types: CONFIG.SONARQUBE.ISSUE_FILTERS.TYPES,
    inNewCodePeriod: CONFIG.SONARQUBE.ISSUE_FILTERS.IN_NEW_CODE_PERIOD,
  });

  try {
    logger.debug(`📡 Fetching issues for project ${projectKey}...`);
    const issueResponse = await fetchWithRetry(
      `${sonarIssueUrl}?${issueParams.toString()}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${sonarToken}:${sonarPassword}`
          ).toString("base64")}`,
          Accept: "application/json",
        },
      }
    );

    if (!issueResponse.ok) {
      throw new Error(
        `HTTP error ${issueResponse.status}: ${await issueResponse.text()}`
      );
    }

    const issueData = await issueResponse.json();
    const issues = issueData.issues || [];

    if (issues.length > 0) {
      logger.success(
        `✅ Found ${issues.length} issues for project ${projectKey}`
      );
      allIssues.push(...issues);
    } else {
      logger.info(`ℹ️  No issues found for project ${projectKey}`);
    }
  } catch (error) {
    logger.error(
      `❌ Failed to fetch issues for project ${projectKey}`,
      error.message
    );
  }

  // Fetch hotspots for this project
  const hotspotParams = new URLSearchParams({
    projectKey: projectKey,
  });

  try {
    logger.debug(`🔒 Fetching security hotspots for project ${projectKey}...`);
    const hotspotResponse = await fetchWithRetry(
      `${sonarHotspotUrl}?${hotspotParams.toString()}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${sonarToken}:${sonarPassword}`
          ).toString("base64")}`,
          Accept: "application/json",
        },
      }
    );

    if (!hotspotResponse.ok) {
      throw new Error(
        `HTTP error ${hotspotResponse.status}: ${await hotspotResponse.text()}`
      );
    }

    const hotspotData = await hotspotResponse.json();
    const hotspots = hotspotData.hotspots || [];

    if (hotspots.length > 0) {
      logger.success(
        `🔒 Found ${hotspots.length} security hotspots for project ${projectKey}`
      );
      allHotspots.push(...hotspots);
    } else {
      logger.info(`ℹ️  No security hotspots found for project ${projectKey}`);
    }
  } catch (error) {
    logger.error(
      `❌ Failed to fetch hotspots for project ${projectKey}`,
      error.message
    );
  }

  logger.debug(`✅ Project ${projectKey} analysis completed`);
}

// Cache for users to avoid repeated lookups
const userAccountCache = {};

// Lookup Jira users in batch
async function lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken) {
  logger.info("👥 Starting Jira user lookup process...");

  // Get unique email addresses from config, filtering out falsy or empty values
  const uniqueEmails = [
    ...new Set(
      projectsConfig.projects
        .filter((p) => p.assignee && p.assignee.trim() !== "")
        .map((p) => p.assignee)
    ),
  ];

  logger.info(
    `📧 Found ${uniqueEmails.length} unique assignee emails to lookup`
  );

  let successCount = 0;
  let cacheHits = 0;

  // Look up each email
  for (const email of uniqueEmails) {
    if (userAccountCache[email]) {
      logger.debug(`💾 Using cached accountId for ${email}`);
      cacheHits++;
      continue;
    }

    try {
      logger.debug(`🔍 Looking up Jira user: ${email}`);
      const userSearchUrl = `${jiraBaseUrl}/rest/api/3/user/search?query=${encodeURIComponent(
        email
      )}`;

      const userResponse = await fetchWithRetry(userSearchUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(
            `${jiraUsername}:${jiraApiToken}`
          ).toString("base64")}`,
        },
      });

      if (userResponse.ok) {
        const userData = await userResponse.json();
        if (userData && userData.length > 0) {
          const user = userData[0];
          userAccountCache[email] = user.accountId;
          logger.success(`✅ Found Jira user: ${email} → ${user.accountId}`);
          successCount++;
        } else {
          logger.warn(`⚠️  Jira user not found: ${email}`);
        }
      } else {
        logger.error(
          `❌ Error looking up user ${email}: ${await userResponse.text()}`
        );
      }
    } catch (error) {
      logger.error(
        `💥 Exception while looking up user ${email}`,
        error.message
      );
    }
  }

  logger.success(`🎉 Jira user lookup completed`, {
    totalEmails: uniqueEmails.length,
    successfulLookups: successCount,
    cacheHits: cacheHits,
    totalCached: Object.keys(userAccountCache).length,
  });

  return userAccountCache;
}

module.exports = {
  getProjectInfo,
  processSingleProject,
  lookupJiraUsers,
  userAccountCache,
  fetchWithRetry,
};
