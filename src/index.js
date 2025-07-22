const { responsify, logger } = require('./utils/microservice.utils');
const sonarToJiraService = require('./service/sonar_to_jira_service');
const { getEnvironmentVariables, isAWSEnvironment } = require('./utils/secrets.utils');
const AWS = require('aws-sdk');

exports.sonarToJiraHandler = async (event, context) => {
    logger.info('🚀 SonarQube to Jira Integration Lambda Started', { 
        requestId: context?.requestId,
        eventType: event?.httpMethod || 'webhook'
    });

    try {
        // Get environment variables from appropriate source
        const envVars = await getEnvironmentVariables();
        logger.info('🔑 Environment Configuration Loaded', {
            environment: isAWSEnvironment() ? 'AWS' : 'Local',
        });

        let projectList = [];
        
        // Skip Lambda invocation if running locally
        const isLocal = process.env.AWS_SAM_LOCAL === 'true' || !process.env.AWS_LAMBDA_FUNCTION_NAME;
        
        if (!isLocal) {
            // Initialize Lambda client here to allow mocking in tests
            const lambda = new AWS.Lambda();
            
            // Step 1: Invoke the project fetcher Lambda (only in AWS environment)
            logger.info('📋 Fetching active projects from Project Fetcher Lambda...');
            const functionName = process.env.PROJECT_FETCHER_FUNCTION || 'ProjectFetcherFunction';
            
            const params = {
                FunctionName: functionName,
                InvocationType: 'RequestResponse',
                Payload: JSON.stringify({})
            };
            
            try {
                logger.debug('🔄 Invoking Project Fetcher Lambda', { functionName });
                const fetcherResult = await lambda.invoke(params).promise();
                
                if (fetcherResult.StatusCode === 200) {
                    logger.success('✨ Project Fetcher Lambda invoked successfully');
                    
                    const fetcherPayload = JSON.parse(fetcherResult.Payload);
                    if (fetcherPayload.statusCode === 200) {
                        const body = typeof fetcherPayload.body === 'string' 
                            ? JSON.parse(fetcherPayload.body) 
                            : fetcherPayload.body;
                            
                        projectList = body.projects || [];
                        logger.info(`📊 Retrieved ${projectList.length} active projects`, {
                            projects: projectList.map(p => ({ key: p.key, name: p.name }))
                        });
                        
                        // If too many projects, process in batches to avoid timeout
                        if (projectList.length > 10) {
                            logger.warn(`⚡ Large project count detected (${projectList.length} projects). Switching to batch processing mode...`);
                            return await processBatchedProjects(projectList);
                        }
                    } else {
                        logger.error('❌ Project Fetcher Lambda returned error response', fetcherPayload);
                    }
                } else {
                    logger.error(`❌ Project fetcher Lambda failed with status code: ${fetcherResult.StatusCode}`);
                }
            } catch (lambdaError) {
                logger.error('🔧 Project Fetcher Lambda invocation failed, falling back to direct SonarQube fetch', lambdaError.message);
            }
        } else {
            logger.info('🏠 Running in local environment, skipping Lambda invocation');
        }

        // Step 2: Fetch issues from SonarQube using the project list
        logger.info('🔍 Starting SonarQube data collection...');
        const sonarIssues = await sonarToJiraService.fetchSonarData(projectList);

        // Step 3: Create Jira tickets for each issue
        logger.info('🎫 Initiating Jira ticket creation process...');
        const createdTickets = await sonarToJiraService.createJiraTickets(sonarIssues);

        // Step 4: Return success response
        logger.success('🎉 SonarQube to Jira integration completed successfully', {
            created: createdTickets.created.length,
            existing: createdTickets.existing.length
        });
        
        return formatResponse(createdTickets);
    } catch (error) {
        logger.error('💥 Critical error in SonarQube to Jira integration', error.message);

        return responsify({
            error: 'Failed to process webhook',
            details: error.message,
        }, 500);
    }
};

// Process projects in batches to avoid timeout
async function processBatchedProjects(projectList) {
    const batchSize = 5; // Process 5 projects at a time
    const totalBatches = Math.ceil(projectList.length / batchSize);
    let allCreatedTickets = [];
    let allExistingTickets = [];
    
    logger.info(`🔄 Starting batch processing: ${projectList.length} projects across ${totalBatches} batches`);
    
    for (let i = 0; i < totalBatches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, projectList.length);
        const batch = projectList.slice(start, end);
        
        logger.progress(i + 1, totalBatches, `Processing batch with ${batch.length} projects`);
        logger.debug(`📦 Batch ${i + 1} contains projects:`, batch.map(p => p.key));
        
        try {
            const sonarIssues = await sonarToJiraService.fetchSonarData(batch);
            const createdTickets = await sonarToJiraService.createJiraTickets(sonarIssues);
            
            allCreatedTickets.push(...createdTickets.created);
            allExistingTickets.push(...createdTickets.existing);
            
            logger.success(`✅ Batch ${i + 1} completed`, {
                batchCreated: createdTickets.created.length,
                batchExisting: createdTickets.existing.length
            });
            
            // Add small delay between batches to prevent overwhelming APIs
            if (i < totalBatches - 1) {
                logger.debug('⏱️  Applying rate limiting delay between batches...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (batchError) {
            logger.error(`❌ Batch ${i + 1} failed, continuing with next batch`, batchError.message);
        }
    }
    
    logger.success('🏁 All batches processed successfully', {
        totalCreated: allCreatedTickets.length,
        totalExisting: allExistingTickets.length
    });
    
    return formatResponse({
        created: allCreatedTickets,
        existing: allExistingTickets
    });
}

function formatResponse(createdTickets) {
    let message;
    let emoji;
    
    if (createdTickets.created.length && createdTickets.existing.length) {
        message = 'Some Jira tickets created, some already existed';
        emoji = '⚡';
    } else if (createdTickets.created.length) {
        message = 'Jira tickets created successfully';
        emoji = '🎉';
    } else if (createdTickets.existing.length) {
        message = 'All Jira tickets already exist';
        emoji = '🔄';
    } else {
        message = 'No Jira tickets created or found';
        emoji = '🤷';
    }
    
    logger.info(`${emoji} Final result: ${message}`, {
        summary: {
            totalCreated: createdTickets.created.length,
            totalExisting: createdTickets.existing.length,
            totalProcessed: createdTickets.created.length + createdTickets.existing.length
        }
    });
    
    return responsify({
        message,
        summary: {
            totalCreated: createdTickets.created.length,
            totalExisting: createdTickets.existing.length,
            totalProcessed: createdTickets.created.length + createdTickets.existing.length
        }
    }, 200);
}
