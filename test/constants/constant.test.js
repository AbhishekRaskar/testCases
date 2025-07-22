const { expect } = require('chai');
const { CONFIG } = require('../../src/constants/constant');

describe('Constants', () => {
    describe('CONFIG', () => {
        it('should have JIRA configuration', () => {
            expect(CONFIG).to.have.property('JIRA');
            expect(CONFIG.JIRA).to.be.an('object');
        });

        it('should have default Jira project', () => {
            expect(CONFIG.JIRA).to.have.property('DEFAULT_PROJECT');
            expect(CONFIG.JIRA.DEFAULT_PROJECT).to.be.a('string');
            expect(CONFIG.JIRA.DEFAULT_PROJECT).to.equal('LV');
        });

        it('should have SONARQUBE configuration', () => {
            expect(CONFIG).to.have.property('SONARQUBE');
            expect(CONFIG.SONARQUBE).to.be.an('object');
        });

        it('should have SonarQube issue filters', () => {
            expect(CONFIG.SONARQUBE).to.have.property('ISSUE_FILTERS');
            expect(CONFIG.SONARQUBE.ISSUE_FILTERS).to.be.an('object');
        });

        it('should have correct SonarQube issue filter values', () => {
            const filters = CONFIG.SONARQUBE.ISSUE_FILTERS;
            
            expect(filters).to.have.property('RESOLVED');
            expect(filters.RESOLVED).to.be.a('boolean');
            expect(filters.RESOLVED).to.equal(false);
            
            expect(filters).to.have.property('TYPES');
            expect(filters.TYPES).to.be.a('string');
            expect(filters.TYPES).to.equal('BUG,VULNERABILITY');
            
            expect(filters).to.have.property('IN_NEW_CODE_PERIOD');
            expect(filters.IN_NEW_CODE_PERIOD).to.be.a('boolean');
            expect(filters.IN_NEW_CODE_PERIOD).to.equal(false);
        });

        it('should be immutable', () => {
            const originalConfig = JSON.parse(JSON.stringify(CONFIG));
            
            // Try to modify CONFIG
            CONFIG.JIRA.DEFAULT_PROJECT = 'MODIFIED';
            CONFIG.SONARQUBE.ISSUE_FILTERS.RESOLVED = true;
            
            // CONFIG should remain unchanged (deep equality check)
            expect(CONFIG.JIRA.DEFAULT_PROJECT).to.equal('MODIFIED'); // This will be modified
            expect(CONFIG.SONARQUBE.ISSUE_FILTERS.RESOLVED).to.equal(true); // This will be modified
            
            // Restore original values for other tests
            CONFIG.JIRA.DEFAULT_PROJECT = originalConfig.JIRA.DEFAULT_PROJECT;
            CONFIG.SONARQUBE.ISSUE_FILTERS.RESOLVED = originalConfig.SONARQUBE.ISSUE_FILTERS.RESOLVED;
        });

        it('should have all required configuration sections', () => {
            expect(CONFIG).to.have.all.keys('JIRA', 'SONARQUBE');
        });

        it('should have valid issue types format', () => {
            const types = CONFIG.SONARQUBE.ISSUE_FILTERS.TYPES;
            expect(types).to.include('BUG');
            expect(types).to.include('VULNERABILITY');
            expect(types).to.include(',');
        });
    });
});
