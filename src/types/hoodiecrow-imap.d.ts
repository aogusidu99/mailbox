/** 测试用 IMAP 服务器 hoodiecrow-imap 的最小类型声明。 */
declare module "hoodiecrow-imap" {
  import type { Server } from "node:net";

  export interface HoodiecrowOptions {
    plugins?: string[];
    id?: Record<string, string>;
    storage?: Record<string, unknown>;
    /** 可登录的用户；默认只有 testuser / testpass */
    users?: Record<string, { password: string }>;
    debug?: boolean;
    secureConnection?: boolean;
  }

  function hoodiecrow(options?: HoodiecrowOptions): Server;
  export default hoodiecrow;
}
