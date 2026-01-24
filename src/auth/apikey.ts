import crypto from 'crypto';
import { logger } from '../utils/logger';
import { config } from '../config/environment';
import { TandaClient } from '../tanda/client';

export interface ApiKeyData {
  keyHash: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  isActive: boolean;
}

export interface ServiceAccountConfig {
  apiKey: string;
  tandaAccessToken: string;
  tandaRefreshToken?: string;
}

class ApiKeyManager {
  private serviceAccount: ServiceAccountConfig | null = null;
  private serviceTandaClient: TandaClient | null = null;

  constructor() {
    this.initializeServiceAccount();
  }

  private initializeServiceAccount(): void {
    const apiKey = config.TANDA_SERVICE_API_KEY;
    const accessToken = config.TANDA_SERVICE_ACCESS_TOKEN;

    if (apiKey && accessToken) {
      this.serviceAccount = {
        apiKey,
        tandaAccessToken: accessToken,
        tandaRefreshToken: config.TANDA_SERVICE_REFRESH_TOKEN,
      };

      // Create a TandaClient with the service account token
      this.serviceTandaClient = new TandaClient(accessToken);

      logger.info('Service account API key authentication enabled');
    } else if (apiKey && !accessToken) {
      logger.warn('TANDA_SERVICE_API_KEY is set but TANDA_SERVICE_ACCESS_TOKEN is missing');
    }
  }

  /**
   * Validate an API key and return the associated TandaClient
   */
  validateApiKey(providedKey: string): TandaClient | null {
    if (!this.serviceAccount || !this.serviceTandaClient) {
      logger.debug('Service account not configured');
      return null;
    }

    // Constant-time comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
      Buffer.from(providedKey),
      Buffer.from(this.serviceAccount.apiKey)
    );

    if (!isValid) {
      logger.warn('Invalid API key provided');
      return null;
    }

    logger.debug('API key validated successfully');
    return this.serviceTandaClient;
  }

  /**
   * Check if service account is configured
   */
  isServiceAccountConfigured(): boolean {
    return this.serviceAccount !== null && this.serviceTandaClient !== null;
  }

  /**
   * Get auth type description for logging
   */
  getAuthType(): string {
    return 'service-api-key';
  }

  /**
   * Generate a new API key (for admin use)
   */
  static generateApiKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}

// Singleton instance
export const apiKeyManager = new ApiKeyManager();
