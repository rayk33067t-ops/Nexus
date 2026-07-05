export type GenesisResponse<T = any> = {
  ok: boolean;
  command: string;
  data: T;
};
