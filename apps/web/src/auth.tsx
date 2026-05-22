import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { DecodedToken } from './types';

const STORAGE_KEY = 'sunscape_jwt';

export function decodeToken(token: string): DecodedToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = JSON.parse(json) as DecodedToken;
    if (!decoded.org_id || !decoded.user_id) return null;
    return decoded;
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  decoded: DecodedToken | null;
}

interface AuthContextValue extends AuthState {
  setToken: (token: string) => boolean;
  clearToken: () => void;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadInitialState(): AuthState {
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) return { token: null, decoded: null };
  const decoded = decodeToken(token);
  if (!decoded) return { token: null, decoded: null };
  if (decoded.exp && decoded.exp * 1000 < Date.now()) {
    localStorage.removeItem(STORAGE_KEY);
    return { token: null, decoded: null };
  }
  return { token, decoded };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadInitialState);

  const setToken = useCallback((token: string): boolean => {
    const decoded = decodeToken(token.trim());
    if (!decoded) return false;
    localStorage.setItem(STORAGE_KEY, token.trim());
    setState({ token: token.trim(), decoded });
    return true;
  }, []);

  const clearToken = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState({ token: null, decoded: null });
  }, []);

  return (
    <AuthContext.Provider value={{
      ...state,
      setToken,
      clearToken,
      isAdmin: state.decoded?.role === 'admin',
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
