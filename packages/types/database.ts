export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      assets: {
        Row: {
          color: string
          created_at: string
          hidden: boolean
          id: number
          motive_vehicle_id: string | null
          name: string
          notes: string | null
          org_id: string
          sort_order: number
          truck: string | null
          type: string
          unit: string | null
        }
        Insert: {
          color?: string
          created_at?: string
          hidden?: boolean
          id?: number
          motive_vehicle_id?: string | null
          name: string
          notes?: string | null
          org_id: string
          sort_order?: number
          truck?: string | null
          type?: string
          unit?: string | null
        }
        Update: {
          color?: string
          created_at?: string
          hidden?: boolean
          id?: number
          motive_vehicle_id?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          sort_order?: number
          truck?: string | null
          type?: string
          unit?: string | null
        }
        Relationships: []
      }
      check_calls: {
        Row: {
          body: string
          by_name: string
          channel: string
          created_at: string
          id: string
          load_id: string
          next_check_at: string | null
          org_id: string
          ts: string
          with_party: string
        }
        Insert: {
          body: string
          by_name: string
          channel: string
          created_at?: string
          id?: string
          load_id: string
          next_check_at?: string | null
          org_id: string
          ts?: string
          with_party: string
        }
        Update: {
          body?: string
          by_name?: string
          channel?: string
          created_at?: string
          id?: string
          load_id?: string
          next_check_at?: string | null
          org_id?: string
          ts?: string
          with_party?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_calls_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "loads"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          aliases: string[] | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string | null
          id: string
          mc_num: string | null
          name: string
          notes: string | null
          org_id: string
          short_name: string | null
        }
        Insert: {
          aliases?: string[] | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          id?: string
          mc_num?: string | null
          name: string
          notes?: string | null
          org_id: string
          short_name?: string | null
        }
        Update: {
          aliases?: string[] | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          id?: string
          mc_num?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          short_name?: string | null
        }
        Relationships: []
      }
      dispatchers: {
        Row: {
          created_at: string | null
          id: string
          is_default: boolean | null
          name: string
          org_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          name: string
          org_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          name?: string
          org_id?: string
        }
        Relationships: []
      }
      driver_asset_prefs: {
        Row: {
          asset_id: number
          driver_id: number
          org_id: string
        }
        Insert: {
          asset_id: number
          driver_id: number
          org_id: string
        }
        Update: {
          asset_id?: number
          driver_id?: number
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_asset_prefs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_asset_prefs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_push_tokens: {
        Row: {
          created_at: string
          driver_id: number
          id: number
          last_seen_at: string
          org_id: string
          platform: string
          token: string
        }
        Insert: {
          created_at?: string
          driver_id: number
          id?: number
          last_seen_at?: string
          org_id: string
          platform: string
          token: string
        }
        Update: {
          created_at?: string
          driver_id?: number
          id?: number
          last_seen_at?: string
          org_id?: string
          platform?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          created_at: string
          first_name: string | null
          id: number
          last_name: string | null
          name: string
          notes: string | null
          org_id: string
          phone: string | null
        }
        Insert: {
          created_at?: string
          first_name?: string | null
          id?: number
          last_name?: string | null
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
        }
        Update: {
          created_at?: string
          first_name?: string | null
          id?: number
          last_name?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
        }
        Relationships: []
      }
      events: {
        Row: {
          accessorials: Json | null
          asset_id: number
          audit_log: Json | null
          broker: string | null
          created_at: string
          created_by_name: string | null
          deleted_at: string | null
          dispatcher: string | null
          driver_id: number | null
          driver_name: string | null
          driver_pay: number | null
          end: string
          event_kind: string
          id: string
          internal_load_id: number
          load_id: string | null
          load_num: string | null
          load_price: number | null
          non_revenue_type: string | null
          notes: string | null
          org_id: string
          priority: boolean
          rate_con_pdf: string | null
          ref_nums: string | null
          relay_group_id: string | null
          relay_role: string | null
          special_instructions: string | null
          start: string
          status: string
          title: string
          trailer_id: number | null
          trailer_type: string | null
          updated_at: string
        }
        Insert: {
          accessorials?: Json | null
          asset_id: number
          audit_log?: Json | null
          broker?: string | null
          created_at?: string
          created_by_name?: string | null
          deleted_at?: string | null
          dispatcher?: string | null
          driver_id?: number | null
          driver_name?: string | null
          driver_pay?: number | null
          end: string
          event_kind?: string
          id?: string
          internal_load_id: number
          load_id?: string | null
          load_num?: string | null
          load_price?: number | null
          non_revenue_type?: string | null
          notes?: string | null
          org_id: string
          priority?: boolean
          rate_con_pdf?: string | null
          ref_nums?: string | null
          relay_group_id?: string | null
          relay_role?: string | null
          special_instructions?: string | null
          start: string
          status?: string
          title: string
          trailer_id?: number | null
          trailer_type?: string | null
          updated_at?: string
        }
        Update: {
          accessorials?: Json | null
          asset_id?: number
          audit_log?: Json | null
          broker?: string | null
          created_at?: string
          created_by_name?: string | null
          deleted_at?: string | null
          dispatcher?: string | null
          driver_id?: number | null
          driver_name?: string | null
          driver_pay?: number | null
          end?: string
          event_kind?: string
          id?: string
          internal_load_id?: number
          load_id?: string | null
          load_num?: string | null
          load_price?: number | null
          non_revenue_type?: string | null
          notes?: string | null
          org_id?: string
          priority?: boolean
          rate_con_pdf?: string | null
          ref_nums?: string | null
          relay_group_id?: string | null
          relay_role?: string | null
          special_instructions?: string | null
          start?: string
          status?: string
          title?: string
          trailer_id?: number | null
          trailer_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "loads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_trailer_id_fkey"
            columns: ["trailer_id"]
            isOneToOne: false
            referencedRelation: "trailers"
            referencedColumns: ["id"]
          },
        ]
      }
      load_documents: {
        Row: {
          event_id: string
          file_name: string
          id: string
          kind: string
          load_id: string | null
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
          uploaded_by_driver_id: number | null
        }
        Insert: {
          event_id: string
          file_name: string
          id?: string
          kind?: string
          load_id?: string | null
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
          uploaded_by_driver_id?: number | null
        }
        Update: {
          event_id?: string
          file_name?: string
          id?: string
          kind?: string
          load_id?: string | null
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by_driver_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "load_documents_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "load_documents_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "loads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "load_documents_uploaded_by_driver_id_fkey"
            columns: ["uploaded_by_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      loads: {
        Row: {
          accessorials: Json | null
          audit_log: Json | null
          broker: string | null
          commodity: string | null
          created_at: string
          created_by_name: string | null
          customer_id: string | null
          deleted_at: string | null
          dispatcher: string | null
          id: string
          internal_load_id: number
          internal_notes: Json
          load_num: string | null
          load_price: number | null
          notes: string | null
          org_id: string
          rate_con_pdf: string | null
          ref_nums: string | null
          updated_at: string
          weight: number | null
        }
        Insert: {
          accessorials?: Json | null
          audit_log?: Json | null
          broker?: string | null
          commodity?: string | null
          created_at?: string
          created_by_name?: string | null
          customer_id?: string | null
          deleted_at?: string | null
          dispatcher?: string | null
          id?: string
          internal_load_id: number
          internal_notes?: Json
          load_num?: string | null
          load_price?: number | null
          notes?: string | null
          org_id: string
          rate_con_pdf?: string | null
          ref_nums?: string | null
          updated_at?: string
          weight?: number | null
        }
        Update: {
          accessorials?: Json | null
          audit_log?: Json | null
          broker?: string | null
          commodity?: string | null
          created_at?: string
          created_by_name?: string | null
          customer_id?: string | null
          deleted_at?: string | null
          dispatcher?: string | null
          id?: string
          internal_load_id?: number
          internal_notes?: Json
          load_num?: string | null
          load_price?: number | null
          notes?: string | null
          org_id?: string
          rate_con_pdf?: string | null
          ref_nums?: string | null
          updated_at?: string
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "loads_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      loads_internal_id_counters: {
        Row: {
          last_id: number
          org_id: string
        }
        Insert: {
          last_id?: number
          org_id: string
        }
        Update: {
          last_id?: number
          org_id?: string
        }
        Relationships: []
      }
      org_load_id_counters: {
        Row: {
          last_id: number
          org_id: string
        }
        Insert: {
          last_id?: number
          org_id: string
        }
        Update: {
          last_id?: number
          org_id?: string
        }
        Relationships: []
      }
      org_settings: {
        Row: {
          motive_api_key: string | null
          org_id: string
        }
        Insert: {
          motive_api_key?: string | null
          org_id: string
        }
        Update: {
          motive_api_key?: string | null
          org_id?: string
        }
        Relationships: []
      }
      payroll_adjustments: {
        Row: {
          amount: number
          category: string
          created_at: string
          description: string | null
          driver_name: string
          id: string
          org_id: string
          week_start: string
        }
        Insert: {
          amount: number
          category: string
          created_at?: string
          description?: string | null
          driver_name: string
          id?: string
          org_id: string
          week_start: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string
          description?: string | null
          driver_name?: string
          id?: string
          org_id?: string
          week_start?: string
        }
        Relationships: []
      }
      payroll_records: {
        Row: {
          driver_name: string
          finalized_at: string
          id: string
          notes: string | null
          org_id: string
          total_pay: number
          week_start: string
        }
        Insert: {
          driver_name: string
          finalized_at?: string
          id?: string
          notes?: string | null
          org_id: string
          total_pay: number
          week_start: string
        }
        Update: {
          driver_name?: string
          finalized_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          total_pay?: number
          week_start?: string
        }
        Relationships: []
      }
      saved_locations: {
        Row: {
          address: string | null
          created_at: string
          id: string
          lat: number | null
          lng: number | null
          name: string
          org_id: string
          timezone: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          org_id: string
          timezone?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          org_id?: string
          timezone?: string | null
        }
        Relationships: []
      }
      stops: {
        Row: {
          address: string | null
          appt_end: string | null
          appt_start: string | null
          arrived_at: string | null
          arrived_lat: number | null
          arrived_lng: number | null
          city: string | null
          state: string | null
          created_at: string
          event_id: string
          facility_name: string | null
          geocode_status: string
          id: string
          instructions: string | null
          lat: number | null
          lng: number | null
          org_id: string
          schedule_type: string | null
          sequence: number
          timezone: string | null
          type: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          appt_end?: string | null
          appt_start?: string | null
          arrived_at?: string | null
          arrived_lat?: number | null
          arrived_lng?: number | null
          city?: string | null
          state?: string | null
          created_at?: string
          event_id: string
          facility_name?: string | null
          geocode_status?: string
          id?: string
          instructions?: string | null
          lat?: number | null
          lng?: number | null
          org_id: string
          schedule_type?: string | null
          sequence: number
          timezone?: string | null
          type: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          appt_end?: string | null
          appt_start?: string | null
          arrived_at?: string | null
          arrived_lat?: number | null
          arrived_lng?: number | null
          city?: string | null
          state?: string | null
          created_at?: string
          event_id?: string
          facility_name?: string | null
          geocode_status?: string
          id?: string
          instructions?: string | null
          lat?: number | null
          lng?: number | null
          org_id?: string
          schedule_type?: string | null
          sequence?: number
          timezone?: string | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stops_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      trailers: {
        Row: {
          category: string
          created_at: string
          id: number
          motive_vehicle_id: string | null
          name: string
          notes: string | null
          org_id: string
          sort_order: number
          trailer_number: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          id?: never
          motive_vehicle_id?: string | null
          name: string
          notes?: string | null
          org_id: string
          sort_order?: number
          trailer_number?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          id?: never
          motive_vehicle_id?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          sort_order?: number
          trailer_number?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      allocate_loads_internal_id: {
        Args: { p_org_id: string }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
