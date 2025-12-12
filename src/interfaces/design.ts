export interface Design {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
  is_public: boolean;
  share_token?: string;
}

export interface DesignVersion {
  id: string;
  design_id: string;
  version_number: number;
  data: Record<string, any>;
  created_at: string;
  created_by?: string;
  comment?: string;
}

export interface DesignVersionPayload {
  filename: string;
  content: string;
}
