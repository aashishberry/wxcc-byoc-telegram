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
        attachments?: WebexAttachment[];
        timestamp?: number | string;
      };
    };
  };
};

export type WebexAttachment = {
  url?: string;
  fileUrl?: string;
  mimeType?: string;
  fileName?: string;
  encrypted?: boolean;
  jwe?: string;
  keyUri?: string;
  encryptionDetails?: {
    jwe?: string;
    keyUri?: string;
  };
  encryption_details?: {
    jwe?: string;
    keyUri?: string;
  };
};
