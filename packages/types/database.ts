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
          license_state: string | null
          license_expiration: string | null
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
      crm_activities: {
        Row: {
          actor_user_id: string | null
          body: string | null
          created_at: string
          id: string
          kind: string
          lead_id: string
          meta: Json | null
          org_id: string
        }
        Insert: {
          actor_user_id?: string | null
          body?: string | null
          created_at?: string
          id?: string
          kind: string
          lead_id: string
          meta?: Json | null
          org_id: string
        }
        Update: {
          actor_user_id?: string | null
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          lead_id?: string
          meta?: Json | null
          org_id?: string
        }
        Relationships: []
      }
      crm_leads: {
        Row: {
          call_attempts: number
          carrier_operation: string | null
          cell_phone: string | null
          created_at: string
          dba_name: string | null
          dot_number: number | null
          email: string | null
          fmcsa_add_date: string | null
          hm_ind: boolean | null
          id: string
          interstate_beyond_100: number | null
          interstate_within_100: number | null
          intrastate_beyond_100: number | null
          intrastate_within_100: number | null
          legal_name: string
          mcs150_date: string | null
          next_action_at: string | null
          org_id: string
          owner_user_id: string | null
          phone: string | null
          phy_city: string | null
          phy_state: string | null
          phy_street: string | null
          phy_zip: string | null
          power_units: number | null
          raw: Json | null
          source: string
          status: string
          status_changed_at: string
          total_drivers: number | null
          unsubscribe_token: string
          updated_at: string
        }
        Insert: {
          call_attempts?: number
          carrier_operation?: string | null
          cell_phone?: string | null
          created_at?: string
          dba_name?: string | null
          dot_number?: number | null
          email?: string | null
          fmcsa_add_date?: string | null
          hm_ind?: boolean | null
          id?: string
          interstate_beyond_100?: number | null
          interstate_within_100?: number | null
          intrastate_beyond_100?: number | null
          intrastate_within_100?: number | null
          legal_name: string
          mcs150_date?: string | null
          next_action_at?: string | null
          org_id: string
          owner_user_id?: string | null
          phone?: string | null
          phy_city?: string | null
          phy_state?: string | null
          phy_street?: string | null
          phy_zip?: string | null
          power_units?: number | null
          raw?: Json | null
          source?: string
          status?: string
          status_changed_at?: string
          total_drivers?: number | null
          unsubscribe_token?: string
          updated_at?: string
        }
        Update: {
          call_attempts?: number
          carrier_operation?: string | null
          cell_phone?: string | null
          created_at?: string
          dba_name?: string | null
          dot_number?: number | null
          email?: string | null
          fmcsa_add_date?: string | null
          hm_ind?: boolean | null
          id?: string
          interstate_beyond_100?: number | null
          interstate_within_100?: number | null
          intrastate_beyond_100?: number | null
          intrastate_within_100?: number | null
          legal_name?: string
          mcs150_date?: string | null
          next_action_at?: string | null
          org_id?: string
          owner_user_id?: string | null
          phone?: string | null
          phy_city?: string | null
          phy_state?: string | null
          phy_street?: string | null
          phy_zip?: string | null
          power_units?: number | null
          raw?: Json | null
          source?: string
          status?: string
          status_changed_at?: string
          total_drivers?: number | null
          unsubscribe_token?: string
          updated_at?: string
        }
        Relationships: []
      }
      crm_sync_state: {
        Row: {
          cursor: Json
          last_error: string | null
          last_run_at: string | null
          org_id: string
          source: string
          updated_at: string
        }
        Insert: {
          cursor?: Json
          last_error?: string | null
          last_run_at?: string | null
          org_id: string
          source?: string
          updated_at?: string
        }
        Update: {
          cursor?: Json
          last_error?: string | null
          last_run_at?: string | null
          org_id?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      customers: {
        Row: {
          aliases: string[] | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          contacts: Json
          created_at: string | null
          id: string
          mc_num: string | null
          name: string
          invoice_email: string | null
          invoice_instructions: string | null
          invoice_method: string | null
          invoice_portal: string | null
          notes: string | null
          org_id: string
          parse_hints: string | null
          short_name: string | null
        }
        Insert: {
          aliases?: string[] | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contacts?: Json
          created_at?: string | null
          id?: string
          mc_num?: string | null
          name: string
          invoice_email?: string | null
          invoice_instructions?: string | null
          invoice_method?: string | null
          invoice_portal?: string | null
          notes?: string | null
          org_id: string
          parse_hints?: string | null
          short_name?: string | null
        }
        Update: {
          aliases?: string[] | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contacts?: Json
          created_at?: string | null
          id?: string
          mc_num?: string | null
          name?: string
          invoice_email?: string | null
          invoice_instructions?: string | null
          invoice_method?: string | null
          invoice_portal?: string | null
          notes?: string | null
          org_id?: string
          parse_hints?: string | null
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
      driver_evening_sweeps: {
        Row: {
          org_id:     string
          driver_id:  number
          local_date: string
          sent_at:    string
          load_count: number
        }
        Insert: {
          org_id:      string
          driver_id:   number
          local_date:  string
          sent_at?:    string
          load_count?: number
        }
        Update: {
          org_id?:     string
          driver_id?:  string
          local_date?: string
          sent_at?:    string
          load_count?: number
        }
        Relationships: []
      }
      load_notifications: {
        Row: {
          id:              string
          org_id:          string
          event_id:        string
          load_id:         string | null
          driver_id:       number
          kind:            string
          sent_at:         string
          sent_by_name:    string
          acknowledged_at: string | null
        }
        Insert: {
          id?:              string
          org_id:           string
          event_id:         string
          load_id?:         string | null
          driver_id:        number
          kind:             string
          sent_at?:         string
          sent_by_name:     string
          acknowledged_at?: string | null
        }
        Update: {
          id?:              string
          org_id?:          string
          event_id?:        string
          load_id?:         string | null
          driver_id?:       number
          kind?:            string
          sent_at?:         string
          sent_by_name?:    string
          acknowledged_at?: string | null
        }
        Relationships: []
      }
      drivers: {
        Row: {
          address: string | null
          created_at: string
          dob: string | null
          email: string | null
          first_name: string | null
          id: number
          last_name: string | null
          license_exp: string | null
          license_number: string | null
          license_state: string | null
          medical_card_exp: string | null
          name: string
          notes: string | null
          org_id: string
          phone: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          dob?: string | null
          email?: string | null
          first_name?: string | null
          id?: number
          last_name?: string | null
          license_exp?: string | null
          license_number?: string | null
          license_state?: string | null
          medical_card_exp?: string | null
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string
          dob?: string | null
          email?: string | null
          first_name?: string | null
          id?: number
          last_name?: string | null
          license_exp?: string | null
          license_number?: string | null
          license_state?: string | null
          medical_card_exp?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
        }
        Relationships: []
      }
      driver_documents: {
        Row: {
          driver_id: number
          expires_on: string | null
          file_name: string
          id: string
          kind: string
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          driver_id: number
          expires_on?: string | null
          file_name: string
          id?: string
          kind: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          driver_id?: number
          expires_on?: string | null
          file_name?: string
          id?: string
          kind?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_documents_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      // Hand-authored — will be regenerated when `supabase gen types
      // typescript` runs next. Mirrors driver_documents but FK'd to
      // assets / trailers instead of drivers.
      asset_documents: {
        Row: {
          asset_id: number
          expires_on: string | null
          file_name: string
          id: string
          kind: string
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          asset_id: number
          expires_on?: string | null
          file_name: string
          id?: string
          kind: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          asset_id?: number
          expires_on?: string | null
          file_name?: string
          id?: string
          kind?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_documents_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      trailer_documents: {
        Row: {
          trailer_id: number
          expires_on: string | null
          file_name: string
          id: string
          kind: string
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          trailer_id: number
          expires_on?: string | null
          file_name: string
          id?: string
          kind: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          trailer_id?: number
          expires_on?: string | null
          file_name?: string
          id?: string
          kind?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "trailer_documents_trailer_id_fkey"
            columns: ["trailer_id"]
            isOneToOne: false
            referencedRelation: "trailers"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          accessorials: Json | null
          asset_id: number
          audit_log: Json | null
          broker: string | null
          confirm_reminder_sent_at: string | null
          confirmed_at: string | null
          confirmed_by: number | null
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
          loaded_miles: number | null
          non_revenue_type: string | null
          notes: string | null
          org_id: string
          priority: boolean
          rate_con_pdf: string | null
          ref_nums: string | null
          relay_group_id: string | null
          relay_role: string | null
          route_polyline: string | null
          route_stops_key: string | null
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
          confirm_reminder_sent_at?: string | null
          confirmed_at?: string | null
          confirmed_by?: number | null
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
          loaded_miles?: number | null
          non_revenue_type?: string | null
          notes?: string | null
          org_id: string
          priority?: boolean
          rate_con_pdf?: string | null
          ref_nums?: string | null
          relay_group_id?: string | null
          relay_role?: string | null
          route_polyline?: string | null
          route_stops_key?: string | null
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
          confirm_reminder_sent_at?: string | null
          confirmed_at?: string | null
          confirmed_by?: number | null
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
          loaded_miles?: number | null
          non_revenue_type?: string | null
          notes?: string | null
          org_id?: string
          priority?: boolean
          rate_con_pdf?: string | null
          ref_nums?: string | null
          relay_group_id?: string | null
          relay_role?: string | null
          route_polyline?: string | null
          route_stops_key?: string | null
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
      fuel_reports: {
        Row: {
          asset_id: number
          created_at: string
          def_gallons: number | null
          diesel_gallons: number
          driver_id: number
          id: string
          latitude: number | null
          longitude: number | null
          match_status: string
          notes: string | null
          odometer: number | null
          org_id: string
          reported_at: string
          state: string
          submitted_by: string
          transaction_id: string | null
        }
        Insert: {
          asset_id: number
          created_at?: string
          def_gallons?: number | null
          diesel_gallons: number
          driver_id: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          match_status?: string
          notes?: string | null
          odometer?: number | null
          org_id: string
          reported_at?: string
          state: string
          submitted_by: string
          transaction_id?: string | null
        }
        Update: {
          asset_id?: number
          created_at?: string
          def_gallons?: number | null
          diesel_gallons?: number
          driver_id?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          match_status?: string
          notes?: string | null
          odometer?: number | null
          org_id?: string
          reported_at?: string
          state?: string
          submitted_by?: string
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fuel_reports_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_reports_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      fuel_report_photos: {
        Row: {
          file_name: string
          id: string
          mime_type: string | null
          org_id: string
          report_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
        }
        Insert: {
          file_name: string
          id?: string
          mime_type?: string | null
          org_id: string
          report_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
        }
        Update: {
          file_name?: string
          id?: string
          mime_type?: string | null
          org_id?: string
          report_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fuel_report_photos_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "fuel_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          created_at: string
          customer_id: string | null
          due_at: string | null
          id: string
          invoice_number: string
          issued_at: string
          load_id: string
          org_id: string
          paid_amount: number | null
          paid_at: string | null
          paid_method: string | null
          paid_note: string | null
          sent_at: string | null
          sent_method: string | null
          sent_to: string | null
          snapshot: Json
          status: string
          total: number
          updated_at: string
          void_reason: string | null
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          due_at?: string | null
          id?: string
          invoice_number: string
          issued_at?: string
          load_id: string
          org_id: string
          paid_amount?: number | null
          paid_at?: string | null
          paid_method?: string | null
          paid_note?: string | null
          sent_at?: string | null
          sent_method?: string | null
          sent_to?: string | null
          snapshot: Json
          status?: string
          total?: number
          updated_at?: string
          void_reason?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          due_at?: string | null
          id?: string
          invoice_number?: string
          issued_at?: string
          load_id?: string
          org_id?: string
          paid_amount?: number | null
          paid_at?: string | null
          paid_method?: string | null
          paid_note?: string | null
          sent_at?: string | null
          sent_method?: string | null
          sent_to?: string | null
          snapshot?: Json
          status?: string
          total?: number
          updated_at?: string
          void_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "loads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      load_documents: {
        Row: {
          event_id: string
          file_name: string
          id: string
          invoice_id: string | null
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
          invoice_id?: string | null
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
          invoice_id?: string | null
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
          billing_status: string
          broker: string | null
          commodity: string | null
          created_at: string
          created_by_name: string | null
          customer_id: string | null
          deleted_at: string | null
          dispatcher: string | null
          flagged_at: string | null
          flagged_by: string | null
          flagged_note: string | null
          flagged_reason: string | null
          follow_ups: Json
          id: string
          is_tonu: boolean
          internal_load_id: number
          internal_notes: Json
          invoice_doc_ids: string[]
          load_num: string | null
          load_price: number | null
          notes: string | null
          org_id: string
          rate_con_pdf: string | null
          ref_nums: string | null
          total_billable: number | null
          updated_at: string
          verified_at: string | null
          verified_by: string | null
          weight: number | null
        }
        Insert: {
          accessorials?: Json | null
          audit_log?: Json | null
          billing_status?: string
          broker?: string | null
          commodity?: string | null
          created_at?: string
          created_by_name?: string | null
          customer_id?: string | null
          deleted_at?: string | null
          dispatcher?: string | null
          flagged_at?: string | null
          flagged_by?: string | null
          flagged_note?: string | null
          flagged_reason?: string | null
          follow_ups?: Json
          id?: string
          is_tonu?: boolean
          internal_load_id: number
          internal_notes?: Json
          invoice_doc_ids?: string[]
          load_num?: string | null
          load_price?: number | null
          notes?: string | null
          org_id: string
          rate_con_pdf?: string | null
          ref_nums?: string | null
          /** Computed by DB trigger from load_price + billable accessorials.
           *  Write attempts are ignored (the BEFORE trigger overwrites). */
          total_billable?: number | null
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          weight?: number | null
        }
        Update: {
          accessorials?: Json | null
          audit_log?: Json | null
          billing_status?: string
          broker?: string | null
          commodity?: string | null
          created_at?: string
          created_by_name?: string | null
          customer_id?: string | null
          deleted_at?: string | null
          dispatcher?: string | null
          flagged_at?: string | null
          flagged_by?: string | null
          flagged_note?: string | null
          flagged_reason?: string | null
          follow_ups?: Json
          id?: string
          is_tonu?: boolean
          internal_load_id?: number
          internal_notes?: Json
          invoice_doc_ids?: string[]
          load_num?: string | null
          load_price?: number | null
          notes?: string | null
          org_id?: string
          rate_con_pdf?: string | null
          ref_nums?: string | null
          /** Computed by DB trigger; write attempts are ignored. */
          total_billable?: number | null
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
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
      maintenance_action_items: {
        Row: {
          actual_cost: number | null
          asset_id: number | null
          category: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          description: string | null
          due_date: string | null
          estimated_cost: number | null
          id: string
          org_id: string
          out_of_service: boolean
          priority: string
          report_id: string | null
          scheduled_date: string | null
          status: string
          title: string
          trailer_id: number | null
          updated_at: string
          vendor: string | null
        }
        Insert: {
          actual_cost?: number | null
          asset_id?: number | null
          category?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          due_date?: string | null
          estimated_cost?: number | null
          id?: string
          org_id: string
          out_of_service?: boolean
          priority?: string
          report_id?: string | null
          scheduled_date?: string | null
          status?: string
          title: string
          trailer_id?: number | null
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          actual_cost?: number | null
          asset_id?: number | null
          category?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          due_date?: string | null
          estimated_cost?: number | null
          id?: string
          org_id?: string
          out_of_service?: boolean
          priority?: string
          report_id?: string | null
          scheduled_date?: string | null
          status?: string
          title?: string
          trailer_id?: number | null
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_action_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_action_items_trailer_id_fkey"
            columns: ["trailer_id"]
            isOneToOne: false
            referencedRelation: "trailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_action_items_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "maintenance_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_action_item_photos: {
        Row: {
          action_item_id: string
          file_name: string
          id: string
          mime_type: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          action_item_id: string
          file_name: string
          id?: string
          mime_type?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          action_item_id?: string
          file_name?: string
          id?: string
          mime_type?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_action_item_photos_action_item_id_fkey"
            columns: ["action_item_id"]
            isOneToOne: false
            referencedRelation: "maintenance_action_items"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_report_photos: {
        Row: {
          file_name: string
          id: string
          mime_type: string | null
          org_id: string
          report_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_at: string
        }
        Insert: {
          file_name: string
          id?: string
          mime_type?: string | null
          org_id: string
          report_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_at?: string
        }
        Update: {
          file_name?: string
          id?: string
          mime_type?: string | null
          org_id?: string
          report_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_report_photos_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "maintenance_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_reports: {
        Row: {
          action_item_id: string | null
          asset_id: number | null
          created_at: string
          description: string
          driver_id: number
          id: string
          latitude: number | null
          longitude: number | null
          org_id: string
          reported_at: string
          state: string | null
          status: string
          submitted_by: string
          trailer_id: number | null
        }
        Insert: {
          action_item_id?: string | null
          asset_id?: number | null
          created_at?: string
          description: string
          driver_id: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          org_id: string
          reported_at?: string
          state?: string | null
          status?: string
          submitted_by: string
          trailer_id?: number | null
        }
        Update: {
          action_item_id?: string | null
          asset_id?: number | null
          created_at?: string
          description?: string
          driver_id?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          org_id?: string
          reported_at?: string
          state?: string | null
          status?: string
          submitted_by?: string
          trailer_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_reports_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_reports_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_reports_trailer_id_fkey"
            columns: ["trailer_id"]
            isOneToOne: false
            referencedRelation: "trailers"
            referencedColumns: ["id"]
          },
        ]
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
          crm_settings: Json | null
          motive_api_key: string | null
          org_id: string
          rate_con_settings: Json
        }
        Insert: {
          crm_settings?: Json | null
          motive_api_key?: string | null
          org_id: string
          rate_con_settings?: Json
        }
        Update: {
          crm_settings?: Json | null
          motive_api_key?: string | null
          org_id?: string
          rate_con_settings?: Json
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
