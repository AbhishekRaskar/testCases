const logger = {
    info: (message, data = null) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ℹ️  INFO: ${message}`;
        if (data) {
            console.log(logMessage, data);
        } else {
            console.log(logMessage);
        }
    },
    
    error: (message, error = null) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ❌ ERROR: ${message}`;
        if (error) {
            console.error(logMessage, error);
        } else {
            console.error(logMessage);
        }
    },
    
    warn: (message, data = null) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ⚠️  WARN: ${message}`;
        if (data) {
            console.warn(logMessage, data);
        } else {
            console.warn(logMessage);
        }
    },
    
    success: (message, data = null) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ✅ SUCCESS: ${message}`;
        if (data) {
            console.log(logMessage, data);
        } else {
            console.log(logMessage);
        }
    },
    
    debug: (message, data = null) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] 🔍 DEBUG: ${message}`;
        if (data) {
            console.debug(logMessage, data);
        } else {
            console.debug(logMessage);
        }
    },
    
    progress: (current, total, message) => {
        const percentage = Math.round((current / total) * 100);
        const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] 📊 PROGRESS: [${progressBar}] ${percentage}% - ${message} (${current}/${total})`);
    }
};

const responsify = (data, statusCode = 200) => {
    if (data.errorType) {
        statusCode = 400;
        if (data.errorType === 'NOT_FOUND') {
            statusCode = 404;
        }
    }
    
    return {
        statusCode: statusCode,
        body: JSON.stringify(data),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        }
    };
};

module.exports = {
    responsify,
    logger
};