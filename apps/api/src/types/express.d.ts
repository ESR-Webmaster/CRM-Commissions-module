declare global {
  namespace Express {
    interface Request {
      auth: {
        org_id: string;
        user_id: string;
        role: string;
      };
    }
  }
}

export {};
