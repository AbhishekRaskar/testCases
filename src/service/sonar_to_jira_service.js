const fetch = require('node-fetch');
require('dotenv').config();
const projectsConfig = require("../utils/projectConfig.json");
const { getProjectInfo, processSingleProject, lookupJiraUsers, userAccountCache, fetchWithRetry } = require('../utils/functionUtils');
const { CONFIG } = require('../constants/constant');
const { logger } = require('../utils/microservice.utils');
const { getEnvironmentVariables, validateEnvironmentVariables } = require('../utils/secrets.utils');

// Helper function to validate environment variables
async function validateEnvironmentVariablesFromSecrets() {
    const envVars = await getEnvironmentVariables();
    const requiredEnvVars = ['SONARQUBE_BASE_URL', 'SONARQUBE_TOKEN', 'JIRA_BASE_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN'];
    validateEnvironmentVariables(envVars, requiredEnvVars);
    return envVars;
}

exports.fetchSonarData = async (projectList = []) => {
    // Validate environment variables and get them from appropriate source
    const envVars = await validateEnvironmentVariablesFromSecrets();
    logger.info('🔍 Starting SonarQube data fetch operation...');

    try {
        const sonarBaseUrl = envVars.SONARQUBE_BASE_URL;
        const sonarIssueUrl = `${sonarBaseUrl}/api/issues/search`;
        const sonarHotspotUrl = `${sonarBaseUrl}/api/hotspots/search`;
        const sonarToken = envVars.SONARQUBE_TOKEN;
        const sonarPassword = "";

        // Use provided projectList or fallback to config
        let projects;
        let enabledProjects;

        if (projectList && projectList.length > 0) {
            logger.info(`📋 Using provided project list with ${projectList.length} projects`);
            enabledProjects = projectList;
        } else {
            logger.info('📂 No project list provided, loading from projectConfig.json...');
            projects = projectsConfig.projects || [];
            enabledProjects = projects.filter(project => project.isChecked);
            logger.info(`📊 Found ${enabledProjects.length} enabled projects out of ${projects.length} total`);
        }

        const allIssues = [];
        const allHotspots = [];

        if (enabledProjects.length === 0) {
            logger.warn('⚠️  No enabled projects found in configuration, checking environment fallback...');
            const sonarProjectKey = envVars.SONARQUBE_PROJECT_KEY;

            if (!sonarProjectKey) {
                logger.warn('🚫 No SONARQUBE_PROJECT_KEY environment variable defined. Returning empty results.');
                return { issues: [], hotspots: [] };
            }

            logger.info(`🔄 Using fallback project key: ${sonarProjectKey}`);
            await processSingleProject(sonarProjectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
        } else {
            logger.info(`🚀 Processing ${enabledProjects.length} enabled projects...`);

            // Process enabled projects from config
            let processedCount = 0;
            for (const project of enabledProjects) {
                const projectKey = project.key;
                processedCount++;

                logger.progress(processedCount, enabledProjects.length, `Processing project: ${projectKey}`);
                await processSingleProject(projectKey, sonarIssueUrl, sonarHotspotUrl, sonarToken, sonarPassword, allIssues, allHotspots);
            }
        }

        logger.success('📈 SonarQube data collection completed', {
            totalIssues: allIssues.length,
            totalHotspots: allHotspots.length,
            projectsProcessed: enabledProjects.length || 1
        });

        if (!allIssues.length && !allHotspots.length) {
            logger.warn('🤷 No issues or hotspots found in SonarQube response');
        }

        return { issues: allIssues, hotspots: allHotspots };
    } catch (error) {
        const enhancedError = new Error(`SonarQube fetch failed: ${error.message}`);
        enhancedError.originalError = error;
        logger.error('💥 Critical error during SonarQube data fetch', enhancedError.message);
        throw enhancedError;
    }
};

// jira ticket creation function
exports.createJiraTickets = async (sonarData) => {
    // Validate environment variables and get them from appropriate source
    const envVars = await validateEnvironmentVariablesFromSecrets();
    
    logger.info('🎫 Starting Jira ticket creation process...');

    if (!sonarData) {
        throw new Error('sonarData is required for createJiraTickets');
    }

    const { issues, hotspots } = sonarData;
    const totalItems = issues.length + hotspots.length;

    logger.info(`📊 Processing ${totalItems} items (${issues.length} issues, ${hotspots.length} hotspots)`);

    try {
        const jiraBaseUrl = envVars.JIRA_BASE_URL;
        const jiraIssueUrl = `${jiraBaseUrl}/rest/api/3/issue`;
        const jiraUsername = envVars.JIRA_USERNAME;
        const jiraApiToken = envVars.JIRA_API_TOKEN;
        const jiraDefaultProject = CONFIG.JIRA.DEFAULT_PROJECT;
        const jiraSearchUrl = `${jiraBaseUrl}/rest/api/3/search`;
        const sonarBaseUrl = envVars.SONARQUBE_BASE_URL;

        logger.info('👥 Looking up Jira user accounts...');
        await lookupJiraUsers(jiraBaseUrl, jiraUsername, jiraApiToken);
        logger.success(`✅ Jira user lookup completed (${Object.keys(userAccountCache).length} users cached)`);

        // rate limiter to prevent Jira API throttling
        const rateLimiter = {
            lastCall: 0,
            minInterval: 100, // 100ms between calls

            async wait() {
                const now = Date.now();
                const timeSinceLastCall = now - this.lastCall;
                if (timeSinceLastCall < this.minInterval) {
                    await new Promise(resolve =>
                        setTimeout(resolve, this.minInterval - timeSinceLastCall)
                    );
                }
                this.lastCall = Date.now();
            }
        };

        const createdTickets = [];
        const existingTickets = [];

        // Collect all Sonar keys to check
        const allSonarKeys = [
            ...issues.map(issue => issue.key),
            ...hotspots.map(hotspot => hotspot.key)
        ];

        // Create a map to track existing tickets
        const existingTicketsMap = {};

        // Get all existing tickets in one batch
        if (allSonarKeys.length > 0) {
            try {
                logger.info(`🔍 Checking for existing Jira tickets (${allSonarKeys.length} SonarQube keys)...`);

                // Process in batches to avoid JQL length limits
                const maxBatchSize = 50;
                const totalBatches = Math.ceil(allSonarKeys.length / maxBatchSize);

                for (let i = 0; i < allSonarKeys.length; i += maxBatchSize) {
                    const batch = allSonarKeys.slice(i, i + maxBatchSize);
                    const batchNum = Math.floor(i / maxBatchSize) + 1;

                    logger.progress(batchNum, totalBatches, `Checking existing tickets batch`);

                    const jqlQuery = `project = ${jiraDefaultProject} AND (("Sonar Reference Key[Paragraph]" ~ "${batch.join('") OR ("Sonar Reference Key[Paragraph]" ~ "')}")) AND status NOT IN (Closed, Resolved, Done, Verified)`;

                    // Apply rate limiting
                    await rateLimiter.wait();
                    const searchResponse = await fetchWithRetry(jiraSearchUrl, {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
                        },
                        body: JSON.stringify({
                            jql: jqlQuery,
                            fields: ["key", "summary", "customfield_11972"],
                            maxResults: 1000
                        })
                    });

                    if (!searchResponse.ok) {
                        throw new Error(`HTTP error ${searchResponse.status}: ${await searchResponse.text()}`);
                    }

                    const searchData = await searchResponse.json();

                    if (searchData.issues && searchData.issues.length > 0) {
                        logger.debug(`🔍 Found ${searchData.issues.length} existing tickets in batch ${batchNum}`);

                        for (const ticket of searchData.issues) {
                            try {
                                // Extract Sonar key from the custom field
                                const customField = ticket.fields.customfield_11972;
                                if (customField?.content?.length > 0) {
                                    const paragraph = customField.content[0];
                                    if (paragraph.content && paragraph.content.length > 0) {
                                        const sonarKey = paragraph.content[0].text;
                                        existingTicketsMap[sonarKey] = ticket.key;
                                        if (!existingTickets.includes(ticket.key)) {
                                            existingTickets.push(ticket.key);
                                        }
                                    }
                                }
                            } catch (e) {
                                logger.warn(`⚠️  Could not parse Sonar key from ticket ${ticket.key}`, e.message);
                            }
                        }
                    }
                }

                logger.success(`✅ Existing ticket check completed (${existingTickets.length} existing tickets found)`);

            } catch (error) {
                logger.error('❌ Error during batch ticket existence check', error.message);
            }
        }

        // function to check if ticket exists using the map
        const checkIfTicketExists = (sonarKey) => {
            return existingTicketsMap[sonarKey] || null;
        };

        /**
         * Creates a Jira ticket for a SonarQube issue or hotspot
         */
        const createJiraTicket = async (item, itemType) => {
            // Parse file name from component path
            const fileName = item.component.split(':').pop();
            const sonarKey = item.key;
            const projectKey = item.project;
            const projectInfo = getProjectInfo(projectKey);

            // Check if ticket already exists 
            const existingTicket = checkIfTicketExists(sonarKey);
            if (existingTicket) {
                logger.debug(`🔄 Skipping ${itemType} ${sonarKey} - ticket already exists: ${existingTicket}`);
                return;
            }

            logger.info(`🆕 Creating new Jira ticket for ${itemType}: ${item.message.substring(0, 50)}...`);

            // permalink based on item type
            let sonarPermalink;
            if (itemType === 'issue') {
                sonarPermalink = `${sonarBaseUrl}/project/issues?resolved=false&types=${item.type}&id=${projectKey}&issues=${item.key}`;
            } else {
                sonarPermalink = `${sonarBaseUrl}/security_hotspots?id=${projectKey}&hotspots=${item.key}`;
            }

            // Include project name in summary
            let summary = `${item.message} in ${fileName}`;
            if (summary.length > 254) {
                summary = summary.substring(0, 251) + '...';
            }

            // Build description based on item type
            const descriptionItems = [
                // Project information
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Project: ${projectInfo.name} (${projectKey})` }] }] },
                // Issue message 
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Message: ${item.message}` }] }] },
                // Affected file
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `File: ${fileName}` }] }] }
            ];

            descriptionItems.push({
                type: "listItem",
                content: [
                    {
                        type: "paragraph",
                        content: [
                            { type: "text", text: "SonarQube Link: " },
                            { type: "text", text: `View ${itemType === 'issue' ? 'Issue' : 'Hotspot'}`, marks: [{ type: "link", attrs: { href: sonarPermalink } }] }
                        ]
                    }
                ]
            });

            const description = {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "heading",
                        attrs: { level: 3 },
                        content: [{ type: "text", text: `${itemType === 'issue' ? 'Issue' : 'Hotspot'} Details` }]
                    },
                    {
                        type: "bulletList",
                        content: descriptionItems
                    }
                ]
            };

            // Determine priority
            let priorityName;
            if (itemType === 'issue') {
                if (item.severity === 'BLOCKER' || item.severity === 'CRITICAL') {
                    priorityName = 'Highest';
                } else {
                    priorityName = 'High';
                }
            } else {
                if (item.vulnerabilityProbability === 'HIGH' || item.vulnerabilityProbability === 'MEDIUM') {
                    priorityName = 'Highest';
                } else {
                    priorityName = 'High';
                }
            }

            // Create the Jira ticket payload
            const jiraPayload = {
                fields: {
                    project: { key: jiraDefaultProject },
                    summary: summary,
                    description: description,
                    issuetype: { name: 'Bug' },
                    customfield_11972: {
                        type: "doc",
                        version: 1,
                        content: [
                            {
                                type: "paragraph",
                                content: [
                                    { type: "text", text: item.key }
                                ]
                            }
                        ]
                    },
                    priority: { name: priorityName }
                },
            };

            // Add components if available and valid
            if (projectInfo.component && projectInfo.component.trim() !== '') {
                jiraPayload.fields.components = [{ name: projectInfo.component }];
            }

            // Add optional custom fields if they are supported
            try {
                jiraPayload.fields.customfield_10200 = { value: "Others" };
                jiraPayload.fields.customfield_11569 = { value: "Automation" };
            } catch (customFieldError) {
                logger.warn(`⚠️  Error setting custom fields:`, customFieldError.message);
            }

            // Validate required fields
            if (!jiraPayload.fields.summary || jiraPayload.fields.summary.trim() === '') {
                throw new Error('Summary is required and cannot be empty');
            }
            if (!jiraPayload.fields.project?.key) {
                throw new Error('Project key is required');
            }
            if (!jiraPayload.fields.issuetype?.name) {
                throw new Error('Issue type is required');
            }

            logger.debug(`📋 Creating Jira ticket with payload:`, {
                summary: jiraPayload.fields.summary,
                project: jiraPayload.fields.project.key,
                issueType: jiraPayload.fields.issuetype.name,
                assignee: jiraPayload.fields.assignee ? `${jiraPayload.fields.assignee.accountId || jiraPayload.fields.assignee.name}` : 'None',
                components: jiraPayload.fields.components?.map(c => c.name).join(', ') || 'None'
            });

            // Add assignee 
            if (projectInfo.assignee) {
                const cachedUser = userAccountCache[projectInfo.assignee];

                if (cachedUser) {
                    jiraPayload.fields.assignee = { accountId: cachedUser };
                    logger.debug(`👤 Assigning ticket to ${projectInfo.assignee} (accountId: ${cachedUser})`);
                } else {
                    // Don't assign if user not found in cache - let Jira handle default assignment
                    logger.warn(`⚠️  User ${projectInfo.assignee} not found in cache, skipping assignment`);
                }
            } else {
                logger.debug(`🤷 No assignee specified for project "${projectKey}"`);
            }

            // Apply rate limiting
            await rateLimiter.wait();
            const jiraResponse = await fetchWithRetry(jiraIssueUrl, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
                },
                body: JSON.stringify(jiraPayload)
            });

            if (!jiraResponse.ok) {
                const errorText = await jiraResponse.text();
                logger.error(`❌ Jira API error for ${itemType} ${item.key}:`, {
                    status: jiraResponse.status,
                    statusText: jiraResponse.statusText,
                    response: errorText,
                    payload: JSON.stringify(jiraPayload, null, 2)
                });
                throw new Error(`HTTP ${jiraResponse.status}: ${errorText}`);
            }

            const jiraData = await jiraResponse.json();
            logger.success(`🎉 Jira ticket created successfully: ${jiraData.key}`, {
                sonarKey: item.key,
                project: projectKey,
                type: itemType
            });
            createdTickets.push(jiraData.key);
        };

        // Process issues
        logger.info(`🐛 Processing ${issues.length} SonarQube issues...`);
        let processedIssues = 0;
        for (const issue of issues) {
            processedIssues++;
            logger.progress(processedIssues, issues.length, `Processing issue ${issue.key}`);
            try {
                await createJiraTicket(issue, 'issue');
            } catch (error) {
                logger.error(`❌ Failed to create ticket for issue ${issue.key}:`, {
                    message: error.message,
                    issueKey: issue.key,
                    project: issue.project
                });
                // Continue processing other issues
            }
        }

        // Process hotspots
        logger.info(`🔒 Processing ${hotspots.length} SonarQube security hotspots...`);
        let processedHotspots = 0;
        for (const hotspot of hotspots) {
            processedHotspots++;
            logger.progress(processedHotspots, hotspots.length, `Processing hotspot ${hotspot.key}`);
            try {
                await createJiraTicket(hotspot, 'hotspot');
            } catch (error) {
                logger.error(`❌ Failed to create ticket for hotspot ${hotspot.key}:`, {
                    message: error.message,
                    hotspotKey: hotspot.key,
                    project: hotspot.project
                });
                // Continue processing other hotspots
            }
        }

        logger.success('🏁 Jira ticket creation process completed', {
            newTicketsCreated: createdTickets.length,
            existingTicketsFound: existingTickets.length,
            totalProcessed: createdTickets.length + existingTickets.length,
            totalIssues: issues.length,
            totalHotspots: hotspots.length
        });

        return { created: createdTickets, existing: existingTickets };
    } catch (error) {
        logger.error('💥 Critical error during Jira ticket creation', {
            message: error.message,
            stack: error.stack,
            response: error.response?.data || 'No response data',
            statusCode: error.response?.status || 'Unknown status'
        });

        // Return partial results if available
        return {
            created: createdTickets || [],
            existing: existingTickets || [],
            error: error.message
        };
    }
};

/**
 * Check if multiple SonarQube issues or hotspots are resolved by querying APIs in batches
 * This optimized version reduces API calls by checking multiple keys at once
 */
async function checkMultipleIssuesResolved(sonarKeys, sonarBaseUrl, sonarToken) {
    logger.debug(`🔍 Batch checking ${sonarKeys.length} SonarQube items for resolution status...`);

    const resolvedStatus = {};
    const maxBatchSize = 50; // SonarQube API limit for multiple keys

    try {
        // Initialize all keys as resolved by default - we'll mark them as active if found
        sonarKeys.forEach(key => {
            resolvedStatus[key] = true;
        });

        // Process keys individually since we need to use the show API for hotspots
        for (let i = 0; i < sonarKeys.length; i += maxBatchSize) {
            const batch = sonarKeys.slice(i, i + maxBatchSize);
            logger.debug(`📡 Processing batch ${Math.floor(i / maxBatchSize) + 1}/${Math.ceil(sonarKeys.length / maxBatchSize)} (${batch.length} keys)`);

            // Check issues API with batch of keys - Use 'issues' parameter for batch search
            // Also filter for only unresolved issues (resolved=false)
            const issueApiUrl = `${sonarBaseUrl}/api/issues/search?issues=${batch.join(',')}&resolved=false`;
            logger.debug(`📡 Checking issues API with ${batch.length} keys for unresolved issues...`);

            try {
                const issueResponse = await fetchWithRetry(issueApiUrl, {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${sonarToken}:`).toString('base64')}`,
                        'Accept': 'application/json',
                    }
                });

                if (issueResponse.ok) {
                    const issueData = await issueResponse.json();
                    const foundIssueKeys = (issueData.issues || []).map(issue => issue.key);

                    // Mark found issues as NOT resolved (still active)
                    foundIssueKeys.forEach(key => {
                        resolvedStatus[key] = false;
                        logger.debug(`⚠️  Found active unresolved issue: ${key}`);
                    });

                    logger.info(`🔍 Found ${foundIssueKeys.length} active unresolved issues in batch`);
                } else {
                    const errorText = await issueResponse.text();
                    logger.warn(`⚠️ Issues API error: HTTP ${issueResponse.status} - ${errorText}`);
                }
            } catch (error) {
                logger.error(`❌ Error checking issues batch:`, error.message);
            }

            // Check hotspots individually using the show API
            // We need to be more careful here - only check keys that weren't found as issues
            const keysToCheckAsHotspots = batch.filter(key => resolvedStatus[key] === true);

            const hotspotErrors = [];
            const hotspotResolved = [];
            const hotspotActive = [];

            for (const hotspotKey of keysToCheckAsHotspots) {
                try {
                    const hotspotShowUrl = `${sonarBaseUrl}/api/hotspots/show?hotspot=${hotspotKey}`;
                    
                    const hotspotResponse = await fetchWithRetry(hotspotShowUrl, {
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`${sonarToken}:`).toString('base64')}`,
                            'Accept': 'application/json',
                        }
                    });

                    if (hotspotResponse.ok) {
                        const hotspotData = await hotspotResponse.json();
                        
                        // Check if response contains errors (resolved hotspot)
                        if (hotspotData.errors && hotspotData.errors.length > 0) {
                            // Hotspot is resolved (doesn't exist)
                            hotspotResolved.push(hotspotKey);
                            // resolvedStatus[hotspotKey] remains true (default)
                        } else if (hotspotData.key) {
                            // Hotspot exists and is not resolved
                            resolvedStatus[hotspotKey] = false;
                            hotspotActive.push(hotspotKey);
                        }
                    } else {
                        // If we get a 404 or similar error, assume it's resolved
                        if (hotspotResponse.status === 404) {
                            hotspotResolved.push(hotspotKey);
                            // resolvedStatus[hotspotKey] remains true (default)
                        } else {
                            const errorText = await hotspotResponse.text();
                            hotspotErrors.push({ key: hotspotKey, status: hotspotResponse.status, error: errorText });
                        }
                    }
                } catch (error) {
                    // Only log actual errors, not expected 404s for resolved hotspots
                    if (error.message !== 'HTTP 404') {
                        hotspotErrors.push({ key: hotspotKey, error: error.message });
                    } else {
                        hotspotResolved.push(hotspotKey);
                    }
                }
                
                // Add small delay between individual hotspot checks
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Log batch results for hotspots
            if (hotspotResolved.length > 0) {
                logger.debug(`✅ Resolved hotspots in batch: ${hotspotResolved.length} (${hotspotResolved.slice(0, 3).join(', ')}${hotspotResolved.length > 3 ? '...' : ''})`);
            }
            if (hotspotActive.length > 0) {
                logger.debug(`⚠️  Active hotspots in batch: ${hotspotActive.length} (${hotspotActive.slice(0, 3).join(', ')}${hotspotActive.length > 3 ? '...' : ''})`);
            }
            if (hotspotErrors.length > 0) {
                logger.warn(`❌ Hotspot errors in batch: ${hotspotErrors.length} (${hotspotErrors.slice(0, 2).map(e => `${e.key}:${e.status || 'unknown'}`).join(', ')}${hotspotErrors.length > 2 ? '...' : ''})`);
            }

            // Add a small delay between batches to avoid overwhelming the API
            if (i + maxBatchSize < sonarKeys.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }


        const resolvedCount = Object.values(resolvedStatus).filter(status => status === true).length;
        const activeCount = Object.values(resolvedStatus).filter(status => status === false).length;

        logger.success(`✅ Batch check completed: ${resolvedCount} resolved, ${activeCount} active, ${sonarKeys.length} total`);

        // Log detailed breakdown for troubleshooting
        const resolvedKeys = Object.keys(resolvedStatus).filter(key => resolvedStatus[key] === true);
        const activeKeys = Object.keys(resolvedStatus).filter(key => resolvedStatus[key] === false);
        
        if (resolvedKeys.length > 0) {
            logger.info(`✅ Resolved items: ${resolvedKeys.slice(0, 5).join(', ')}${resolvedKeys.length > 5 ? ` ... and ${resolvedKeys.length - 5} more` : ''}`);
        }
        if (activeKeys.length > 0) {
            logger.info(`🔒 Active items: ${activeKeys.slice(0, 5).join(', ')}${activeKeys.length > 5 ? ` ... and ${activeKeys.length - 5} more` : ''}`);
        }

        return resolvedStatus;

    } catch (error) {
        logger.error(`💥 Error during batch check:`, {
            message: error.message,
            stack: error.stack,
            keysCount: sonarKeys.length
        });

        // Fallback: assume all keys are not resolved for safety
        const fallbackStatus = {};
        sonarKeys.forEach(key => {
            fallbackStatus[key] = false;
        });
        return fallbackStatus;
    }
}


/**
 * Closes a Jira ticket by transitioning it to a closed state
 */
async function closeJiraTicket(jiraTicketKey, sonarKey, jiraUsername, jiraApiToken, jiraBaseUrl) {
    logger.debug(`🔒 Closing Jira ticket ${jiraTicketKey} for resolved SonarQube issue ${sonarKey}...`);

    try {
        // First, get available transitions
        const transitionsUrl = `${jiraBaseUrl}/rest/api/3/issue/${jiraTicketKey}/transitions`;

        const transitionsResponse = await fetchWithRetry(transitionsUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
            }
        });

        if (!transitionsResponse.ok) {
            const errorText = await transitionsResponse.text();
            logger.error(`❌ Failed to get transitions for ticket ${jiraTicketKey}`, {
                status: transitionsResponse.status,
                statusText: transitionsResponse.statusText,
                responseText: errorText,
                ticketKey: jiraTicketKey,
                sonarKey: sonarKey
            });
            throw new Error(`HTTP error ${transitionsResponse.status}: ${errorText}`);
        }

        const transitionsData = await transitionsResponse.json();

        // Find the appropriate transition (Done, Closed, or Resolved)
        const preferredTransitions = ['wont do','Done', 'Closed', 'Resolved', 'Verified'];
        let transitionId = null;
        let transitionName = null;

        for (const preferredName of preferredTransitions) {
            const transition = transitionsData.transitions.find(t => t.name === preferredName);
            if (transition) {
                transitionId = transition.id;
                transitionName = transition.name;
                break;
            }
        }

        if (!transitionId) {
            const availableTransitions = transitionsData.transitions.map(t => t.name).join(', ');
            logger.warn(`⚠️ Could not find a suitable transition for ticket ${jiraTicketKey}`, {
                availableTransitions: availableTransitions,
                preferredTransitions: preferredTransitions
            });
            return false;
        }

        // Map transition names to appropriate resolution IDs
        const transitionResolutionMap = {
            'Verified': '10100',       // Verified
            'wont do': '10001',        // Won't Do
            'Done': '10000',           // Done
            'Closed': '10601',         // Closed
            'Resolved': '10608',       // Resolved
        };

        // Get the appropriate resolution ID for this transition
        const resolutionId = transitionResolutionMap[transitionName] || '10100'; // Default to Verified

        // Apply the transition with a comment
        const commentBody = {
            update: {
                comment: [
                    {
                        add: {
                            body: {
                                type: "doc",
                                version: 1,
                                content: [
                                    {
                                        type: "paragraph",
                                        content: [
                                            {
                                                type: "text",
                                                text: `Automatically closed by the SonarQube-Jira integration as the related SonarQube issue has been resolved.`
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                ]
            },
            fields: {
                resolution: {
                    id: resolutionId
                }
            },
            transition: {
                id: String(transitionId)
            }
        };

        // Try the transition with comment first
        let closeResponse = await fetchWithRetry(transitionsUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
            },
            body: JSON.stringify(commentBody)
        });

        // If that fails, try just the transition without comment
        if (!closeResponse.ok) {
            logger.warn(`⚠️ Transition with comment failed for ticket ${jiraTicketKey}, trying transition only...`);
            
            const transitionOnlyBody = {
                fields: {
                    resolution: {
                        id: resolutionId
                    }
                },
                transition: {
                    id: String(transitionId)
                }
            };

            closeResponse = await fetchWithRetry(transitionsUrl, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
                },
                body: JSON.stringify(transitionOnlyBody)
            });

            // If transition succeeded, add comment separately
            if (closeResponse.ok) {
                logger.debug(`✅ Transition succeeded, adding comment separately for ticket ${jiraTicketKey}...`);
                
                const commentUrl = `${jiraBaseUrl}/rest/api/3/issue/${jiraTicketKey}/comment`;
                const commentPayload = {
                    body: {
                        type: "doc",
                        version: 1,
                        content: [
                            {
                                type: "paragraph",
                                content: [
                                    {
                                        type: "text",
                                        text: `Automatically closed by SonarQube-Jira integration because the corresponding SonarQube issue (${sonarKey}) has been resolved.`
                                    }
                                ]
                            }
                        ]
                    }
                };

                try {
                    const commentResponse = await fetchWithRetry(commentUrl, {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
                        },
                        body: JSON.stringify(commentPayload)
                    });

                    if (!commentResponse.ok) {
                        logger.warn(`⚠️ Failed to add comment to ticket ${jiraTicketKey}, but transition succeeded`);
                    }
                } catch (commentError) {
                    logger.warn(`⚠️ Error adding comment to ticket ${jiraTicketKey}: ${commentError.message}`);
                }
            }
        }

        if (!closeResponse.ok) {
            const errorText = await closeResponse.text();
            logger.error(`❌ Failed to close ticket ${jiraTicketKey}`, {
                status: closeResponse.status,
                statusText: closeResponse.statusText,
                responseText: errorText,
                ticketKey: jiraTicketKey,
                sonarKey: sonarKey,
                transitionId: transitionId,
                transitionName: transitionName
            });
            return false;
        }

        logger.success(`✅ Successfully closed ticket ${jiraTicketKey}`, {
            ticketKey: jiraTicketKey,
            sonarKey: sonarKey,
            transitionUsed: transitionName
        });
        return true;

    } catch (error) {
        logger.error(`❌ Error closing ticket ${jiraTicketKey}`, {
            message: error.message,
            stack: error.stack,
            ticketKey: jiraTicketKey,
            sonarKey: sonarKey
        });
        return false;
    }
}

/**
 * Finds and closes Jira tickets for resolved SonarQube issues
 */
exports.closeResolvedJiraTickets = async () => {
    // Validate environment variables and get them from appropriate source
    const envVars = await validateEnvironmentVariablesFromSecrets();
    
    logger.info('🔄 Starting process to close Jira tickets for resolved SonarQube issues...');

    try {
        const jiraBaseUrl = envVars.JIRA_BASE_URL;
        const jiraUsername = envVars.JIRA_USERNAME;
        const jiraApiToken = envVars.JIRA_API_TOKEN;
        const jiraDefaultProject = CONFIG.JIRA.DEFAULT_PROJECT;
        const jiraSearchUrl = `${jiraBaseUrl}/rest/api/3/search`;
        const sonarBaseUrl = envVars.SONARQUBE_BASE_URL;

        // Define rate limiter for API calls
        const rateLimiter = {
            lastCall: 0,
            minInterval: 100, // 100ms between calls
            async wait() {
                const now = Date.now();
                const timeSinceLastCall = now - this.lastCall;
                if (timeSinceLastCall < this.minInterval) {
                    await new Promise(resolve =>
                        setTimeout(resolve, this.minInterval - timeSinceLastCall)
                    );
                }
                this.lastCall = Date.now();
            }
        };

        // Find all open tickets with Sonar reference keys
        // Exclude tickets that are in "Code Review" and "Code Review Pass" status
        const jqlQuery = `project = ${jiraDefaultProject} AND "Sonar Reference Key[Paragraph]" IS NOT EMPTY AND status NOT IN (Closed, Resolved, Done, Verified, "Code Review", "Code Review Pass")`;

        let startAt = 0;
        const maxResults = 100;
        let totalTickets = 0;
        let allTickets = [];
        let hasMore = true;

        logger.info('📑 Fetching Jira tickets with pagination...');

        // Fetch all tickets with pagination
        while (hasMore) {
            try {
                // Apply rate limiting
                await rateLimiter.wait();
                logger.debug(`🔍 Fetching tickets batch: startAt=${startAt}, maxResults=${maxResults}`);

                const searchResponse = await fetchWithRetry(jiraSearchUrl, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Authorization': `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64')}`
                    },
                    body: JSON.stringify({
                        jql: jqlQuery,
                        fields: ["key", "summary", "customfield_11972", "status"],
                        maxResults: maxResults,
                        startAt: startAt
                    })
                });

                if (!searchResponse.ok) {
                    const errorText = await searchResponse.text();
                    logger.error('❌ Pagination search request failed', {
                        status: searchResponse.status,
                        statusText: searchResponse.statusText,
                        errorText: errorText,
                        startAt: startAt,
                        maxResults: maxResults
                    });
                    throw new Error(`HTTP error ${searchResponse.status}: ${errorText}`);
                }

                const searchData = await searchResponse.json();

                if (!searchData.issues || !Array.isArray(searchData.issues)) {
                    logger.error('❌ Unexpected response format from Jira search', {
                        responseKeys: Object.keys(searchData),
                        hasIssues: !!searchData.issues,
                        isArray: Array.isArray(searchData.issues)
                    });
                    throw new Error('Invalid response format from Jira search API');
                }

                const batchTickets = searchData.issues;
                allTickets = allTickets.concat(batchTickets);

                totalTickets = searchData.total;
                startAt += searchData.issues.length;
                hasMore = startAt < totalTickets;

                logger.progress(Math.min(startAt, totalTickets) / totalTickets * 100, 100,
                    `Fetched ${Math.min(startAt, totalTickets)}/${totalTickets} tickets (${Math.round(Math.min(startAt, totalTickets) / totalTickets * 100)}%)`);

            } catch (error) {
                logger.error('❌ Error during ticket pagination', {
                    message: error.message,
                    startAt: startAt,
                    fetchedSoFar: allTickets.length,
                    stack: error.stack
                });

                // If we have tickets already, process those instead of failing completely
                if (allTickets.length > 0) {
                    logger.warn(`⚠️ Pagination error encountered, but will continue processing ${allTickets.length} tickets already retrieved`);
                    hasMore = false;
                } else {
                    throw error;
                }
            }
        }

        logger.success(`✅ Pagination complete. Total tickets retrieved: ${allTickets.length}`);

        let closedCount = 0;
        let errorCount = 0;
        let notResolvedCount = 0;

        // Extract all Sonar keys from tickets for batch processing
        const ticketSonarKeyMap = {};
        const allSonarKeys = [];

        logger.info('🔍 Extracting SonarQube keys from tickets...');
        allTickets.forEach(ticket => {
            try {
                const customField = ticket.fields.customfield_11972;
                if (customField?.content?.length > 0) {
                    const paragraph = customField.content[0];
                    if (paragraph.content && paragraph.content.length > 0) {
                        const sonarKey = paragraph.content[0].text?.trim();
                        if (sonarKey) {
                            ticketSonarKeyMap[sonarKey] = ticket;
                            allSonarKeys.push(sonarKey);
                            logger.debug(`✅ Extracted SonarQube key: ${sonarKey} from ticket: ${ticket.key}`);
                        } else {
                            logger.warn(`⚠️ Empty Sonar key found in ticket ${ticket.key}`);
                        }
                    } else {
                        logger.warn(`⚠️ No paragraph content found in ticket ${ticket.key}`, {
                            hasCustomField: !!customField,
                            hasContent: !!customField?.content,
                            contentLength: customField?.content?.length || 0
                        });
                    }
                } else {
                    logger.warn(`⚠️ No custom field content found in ticket ${ticket.key}`, {
                        hasCustomField: !!customField,
                        customFieldType: typeof customField
                    });
                }
            } catch (e) {
                logger.warn(`⚠️ Could not extract Sonar key from ticket ${ticket.key}`, e.message);
            }
        });

        logger.success(`✅ Extracted ${allSonarKeys.length} SonarQube keys from ${allTickets.length} tickets`);
        
        if (allSonarKeys.length === 0) {
            logger.warn('⚠️ No SonarQube keys found in any tickets. Nothing to process.');
            return {
                ticketsChecked: allTickets.length,
                ticketsClosed: 0,
                ticketsNotResolved: 0
            };
        }

        // Batch check all SonarQube keys for resolution status
        let resolvedStatusMap = {};
        if (allSonarKeys.length > 0) {
            logger.info(`🔍 Batch checking ${allSonarKeys.length} SonarQube items for resolution status...`);
            resolvedStatusMap = await checkMultipleIssuesResolved(allSonarKeys, sonarBaseUrl, envVars.SONARQUBE_TOKEN);
        }

        // Process tickets based on batch results
        const maxConcurrent = 5;
        const processedTickets = {
            closed: [],
            errors: [],
            notResolved: []
        };
        
        for (let i = 0; i < allTickets.length; i += maxConcurrent) {
            const batch = allTickets.slice(i, i + maxConcurrent);
            const batchPromises = batch.map(async (ticket) => {
                try {
                    // Extract Sonar key from the custom field
                    const customField = ticket.fields.customfield_11972;
                    if (customField?.content?.length > 0) {
                        const paragraph = customField.content[0];
                        if (paragraph.content && paragraph.content.length > 0) {
                            const sonarKey = paragraph.content[0].text?.trim();
                            const ticketStatus = ticket.fields.status.name;

                            if (!sonarKey) {
                                logger.warn(`⚠️ Empty Sonar key found in ticket ${ticket.key}`);
                                errorCount++;
                                processedTickets.errors.push(ticket.key);
                                return;
                            }

                            // Check resolution status from batch results
                            const isResolved = resolvedStatusMap[sonarKey];

                            if (isResolved === true) {
                                // Close the ticket
                                await rateLimiter.wait();
                                const closed = await closeJiraTicket(ticket.key, sonarKey, jiraUsername, jiraApiToken, jiraBaseUrl);
                                if (closed) {
                                    closedCount++;
                                    processedTickets.closed.push(ticket.key);
                                    logger.debug(`✅ Successfully closed ticket ${ticket.key} for resolved issue ${sonarKey}`);
                                } else {
                                    errorCount++;
                                    processedTickets.errors.push(ticket.key);
                                    logger.error(`❌ Failed to close ticket ${ticket.key} for resolved issue ${sonarKey}`);
                                }
                            } else if (isResolved === false) {
                                notResolvedCount++;
                                processedTickets.notResolved.push(ticket.key);
                                // logger.debug(`⏳ SonarQube item ${sonarKey} is still active, not closing ticket ${ticket.key}`);
                            } else {
                                // This shouldn't happen with our new logic, but handle it anyway
                                logger.warn(`⚠️ Unknown resolution status for SonarQube item ${sonarKey}, skipping ticket ${ticket.key}`);
                                errorCount++;
                                processedTickets.errors.push(ticket.key);
                            }
                        } else {
                            logger.warn(`⚠️ Could not extract paragraph content from ticket ${ticket.key}`, {
                                contentLength: paragraph.content ? paragraph.content.length : 0,
                                paragraph: JSON.stringify(paragraph)
                            });
                            errorCount++;
                            processedTickets.errors.push(ticket.key);
                        }
                    } else {
                        logger.warn(`⚠️ Could not extract Sonar key from ticket ${ticket.key}`, {
                            hasCustomField: !!customField,
                            hasContent: customField ? !!customField.content : false,
                            contentLength: customField && customField.content ? customField.content.length : 0
                        });
                        errorCount++;
                        processedTickets.errors.push(ticket.key);
                    }
                } catch (e) {
                    errorCount++;
                    processedTickets.errors.push(ticket.key);
                    logger.error(`❌ Error processing ticket ${ticket.key}`, {
                        message: e.message,
                        stack: e.stack,
                        ticketKey: ticket.key,
                        ticketSummary: ticket.fields.summary
                    });
                }
            });

            // Wait for batch to complete
            await Promise.all(batchPromises);
            
            // Log progress every 50 tickets or at the end
            if ((i + batch.length) % 50 === 0 || i + batch.length >= allTickets.length) {
                logger.info(`📊 Processed ${i + batch.length}/${allTickets.length} tickets (${Math.round((i + batch.length) / allTickets.length * 100)}%) - Closed: ${closedCount}, Errors: ${errorCount}, Not Resolved: ${notResolvedCount}`);
            }
        }

        // Log final summary with ticket numbers
        if (processedTickets.closed.length > 0) {
            logger.info(`✅ Closed tickets (${processedTickets.closed.length}): ${processedTickets.closed.slice(0, 20).join(', ')}${processedTickets.closed.length > 20 ? ` ... and ${processedTickets.closed.length - 20} more` : ''}`);
        }
        if (processedTickets.errors.length > 0) {
            logger.warn(`❌ Error tickets (${processedTickets.errors.length}): ${processedTickets.errors.slice(0, 20).join(', ')}${processedTickets.errors.length > 20 ? ` ... and ${processedTickets.errors.length - 20} more` : ''}`);
        }
        if (processedTickets.notResolved.length > 0) {
            logger.info(`⏳ Not resolved tickets (${processedTickets.notResolved.length}): ${processedTickets.notResolved.slice(0, 20).join(', ')}${processedTickets.notResolved.length > 20 ? ` ... and ${processedTickets.notResolved.length - 20} more` : ''}`);
        }

        logger.success(`🏁 Ticket processing completed. Results:`, {
            ticketsChecked: allTickets.length,
            ticketsClosed: closedCount,
            ticketsNotResolved: notResolvedCount,
            ticketsWithErrors: errorCount,
            sonarKeysExtracted: allSonarKeys.length
        });

        return {
            ticketsChecked: allTickets.length,
            ticketsClosed: closedCount,
            ticketsNotResolved: notResolvedCount,
            ticketsWithErrors: errorCount
        };

    } catch (error) {
        logger.error('💥 Critical error during ticket closure process', {
            message: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause
        });
        throw error;
    }
};

// Export internal functions for testing
exports._test = {
    validateEnvironmentVariables,
    checkMultipleIssuesResolved,
    closeJiraTicket
};
