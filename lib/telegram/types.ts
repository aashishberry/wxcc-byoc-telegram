export type TelegramUser = {
  id: number | string;
  is_bot?: boolean;
};

export type TelegramChat = {
  id: number | string;
  type: "private" | "group" | "supergroup" | "channel";
};

export type TelegramFileReference = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  date: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramFileReference[];
  document?: TelegramFileReference;
  audio?: TelegramFileReference;
  video?: TelegramFileReference;
  voice?: TelegramFileReference;
  video_note?: TelegramFileReference;
  animation?: TelegramFileReference;
  sticker?: unknown;
  location?: unknown;
  contact?: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
};
