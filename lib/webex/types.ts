export type WebexEvent = {
  id?: string;
  type?: string;
  comciscotimestamp?: number | string;
  data?: {
    taskId?: string;
    messageDirection?: string;
    direction?: string;
    senderType?: string;
    reason?: string;
    createdTime?: number | string;
    channelType?: string;
    channel?: string;
    channelParams?: {
      message?: {
        aliasId?: string;
        text?: string;
        attachments?: unknown[];
        timestamp?: number | string;
      };
    };
  };
};
