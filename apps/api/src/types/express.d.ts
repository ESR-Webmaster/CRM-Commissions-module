declare global {
  namespace Express {
    interface Request {
      auth: {
        org_id: string;
        user_id: string;
        role: string;
      };
      // Raw request body bytes captured before JSON parsing — used for HMAC webhook validation
      rawBody?: Buffer;
    }
  }
}

export {};
