const { responsify, logger } = require('../utils/microservice.utils');
const sonarToJiraService = require('../service/sonar_to_jira_service');

exports.ticketCloserHandler = async (event, context) => {
    logger.info('🚀 SonarQube to Jira Ticket Closer Lambda Started', { 
        requestId: context?.requestId,
        eventType: event?.httpMethod || 'scheduled',
        timestamp: new Date().toISOString()
    });

    try {
        // Close resolved Jira tickets
        logger.info('🔍 Starting process to close Jira tickets for resolved SonarQube issues...');
        const result = await sonarToJiraService.closeResolvedJiraTickets();
        
        // Format response
        const message = `Successfully processed ${result.ticketsChecked} tickets, closed ${result.ticketsClosed} resolved tickets`;
            
        logger.success(`✅ ${message}`);
        
        return responsify({
            message,
            summary: result
        }, 200);
    } catch (error) {
        logger.error('💥 Critical error in ticket closer function', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        
        return responsify({
            error: 'Failed to process ticket closing',
            details: error.message,
            timestamp: new Date().toISOString()
        }, 500);
    }
};
