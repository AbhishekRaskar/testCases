const projectsConfig = require('../utils/projectConfig.json');
const { responsify, logger } = require('../utils/microservice.utils');

exports.projectFetcherHandler = async (event, context) => {
    logger.info('🚀 Project Fetcher Lambda: Starting project discovery...', {
        requestId: context?.requestId
    });

    try {
        // Get projects from config.json and filter for enabled ones
        const projects = projectsConfig.projects || [];
        const enabledProjects = projects.filter(project => project.isChecked && project.key);
        
        logger.success(`📊 Project analysis completed`, {
            totalProjects: projects.length,
            enabledProjects: enabledProjects.length,
            disabledProjects: projects.length - enabledProjects.length
        });

        // Handle fallback to environment variable if no enabled projects
        if (enabledProjects.length === 0) {
            logger.warn('⚠️  No enabled projects defined in configuration. Checking for SONARQUBE_PROJECT_KEY...');
            const sonarProjectKey = process.env.SONARQUBE_PROJECT_KEY;
            
            if (sonarProjectKey) {
                logger.info(`🔄 Using fallback project key from environment: ${sonarProjectKey}`);
                return responsify({ 
                    projects: [{ key: sonarProjectKey, isChecked: true }],
                    fallback: true,
                    message: 'Using environment fallback project'
                }, 200);
            }
            
            logger.warn('🚫 No projects enabled and no fallback key defined in environment');
            return responsify({ 
                projects: [], 
                fallback: false,
                message: 'No active projects found'
            }, 200);
        }

        logger.info(`✅ Returning ${enabledProjects.length} active projects`, {
            projectKeys: enabledProjects.map(p => p.key)
        });

        return responsify({ 
            projects: enabledProjects, 
            fallback: false,
            message: `Found ${enabledProjects.length} active projects`
        }, 200);
    } catch (error) {
        logger.error('💥 Critical error fetching projects', error.message);
        return responsify({ 
            error: 'Failed to fetch projects', 
            details: error.message,
            projects: []
        }, 500);
    }
};