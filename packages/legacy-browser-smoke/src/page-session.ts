export interface PageSession {
  command<T>(method: string, params?: object): Promise<T>;
  on(method: string, listener: (params: object) => void): () => void;
}
