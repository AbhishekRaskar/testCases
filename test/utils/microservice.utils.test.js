const { expect } = require('chai');
const { responsify } = require('../../src/utils/microservice.utils');

describe('Microservice Utils', () => {
  describe('responsify', () => {
    it('should return a properly formatted successful response', () => {
      const data = { message: 'Success' };
      const response = responsify(data);
      
      expect(response).to.have.property('statusCode', 200);
      expect(response).to.have.property('body').that.equals(JSON.stringify(data));
      expect(response).to.have.property('headers').that.includes({
        'Access-Control-Allow-Origin': '*'
      });
    });
    
    it('should handle error responses', () => {
      const data = { errorType: 'NOT_FOUND', message: 'Resource not found' };
      const response = responsify(data);
      
      expect(response).to.have.property('statusCode', 404);
      expect(response.body).to.include('Resource not found');
    });
    
    it('should use provided status code', () => {
      const data = { message: 'Created' };
      const response = responsify(data, 201);
      
      expect(response).to.have.property('statusCode', 201);
    });
  });
});