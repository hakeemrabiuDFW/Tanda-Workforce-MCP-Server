// Test environment setup

// Set test environment variables before any imports
process.env.NODE_ENV = 'test';
process.env.TANDA_CLIENT_ID = 'test-client-id';
process.env.TANDA_CLIENT_SECRET = 'test-client-secret';
process.env.TANDA_REDIRECT_URI = 'http://localhost:3000/auth/callback';
process.env.SESSION_SECRET = 'test-session-secret-must-be-32-chars-long';
process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-characters';
process.env.PORT = '3001';
process.env.HOST = 'localhost';

// Suppress console output during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});
