// What `plexivo-generate-types` writes for examples/schema.sql. Regenerate
// it for your own tables:
//   PLEXIVO_DATA_URL=… PLEXIVO_PUBLISHABLE_KEY=… npx plexivo-generate-types --output database.types.ts
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Database {
  public: {
    Tables: {
      messages: {
        Row: {
          id: number;
          author_id: string;
          room: string;
          body: string;
          created_at: string;
        };
        Insert: {
          id?: number;
          author_id?: string;
          room?: string;
          body: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          author_id?: string;
          room?: string;
          body?: string;
          created_at?: string;
        };
      };
      todos: {
        Row: {
          id: number;
          owner_id: string;
          title: string;
          done: boolean;
          created_at: string;
        };
        Insert: {
          id?: number;
          owner_id?: string;
          title: string;
          done?: boolean;
          created_at?: string;
        };
        Update: {
          id?: number;
          owner_id?: string;
          title?: string;
          done?: boolean;
          created_at?: string;
        };
      };
    };
    Functions: {
    };
  };
}
