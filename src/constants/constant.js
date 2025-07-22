const CONFIG = {
    JIRA: {
        DEFAULT_PROJECT: 'LV'
    },
    SONARQUBE: {
        ISSUE_FILTERS: {
            RESOLVED: false,
            TYPES: 'BUG,VULNERABILITY',
            IN_NEW_CODE_PERIOD: false
        }
    }
};

module.exports = {
    CONFIG
}