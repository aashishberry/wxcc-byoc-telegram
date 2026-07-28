export type TelegramUser = {
  id: number | string;
  is_bot?: boolean;
};

export type TelegramChat = {
  id: number | string;
  type: "private" | "group" | "supergroup" | "channel";
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  date: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  audio?: unknown;
  video?: unknown;
  voice?: unknown;
  video_note?: unknown;
  animation?: unknown;
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
