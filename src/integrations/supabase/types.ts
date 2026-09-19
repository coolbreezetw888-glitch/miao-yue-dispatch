export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      booking_assistants: {
        Row: {
          booking_id: string
          created_at: string
          id: string
          staff_id: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          id?: string
          staff_id: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_assistants_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_assistants_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_commission_records: {
        Row: {
          booking_id: string
          commission_amount: number
          commission_base_amount_snapshot: number
          commission_basis_type_snapshot: string
          commission_rate_percentage_snapshot: number
          computed_at: string
          created_at: string
          id: string
          material_cost_deducted_snapshot: number
          merchant_id: string
          recalculated_at: string | null
          staff_id: string | null
          updated_at: string
        }
        Insert: {
          booking_id: string
          commission_amount: number
          commission_base_amount_snapshot: number
          commission_basis_type_snapshot: string
          commission_rate_percentage_snapshot: number
          computed_at?: string
          created_at?: string
          id?: string
          material_cost_deducted_snapshot?: number
          merchant_id: string
          recalculated_at?: string | null
          staff_id?: string | null
          updated_at?: string
        }
        Update: {
          booking_id?: string
          commission_amount?: number
          commission_base_amount_snapshot?: number
          commission_basis_type_snapshot?: string
          commission_rate_percentage_snapshot?: number
          computed_at?: string
          created_at?: string
          id?: string
          material_cost_deducted_snapshot?: number
          merchant_id?: string
          recalculated_at?: string | null
          staff_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_commission_records_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_commission_records_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_commission_records_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_material_costs: {
        Row: {
          amount_snapshot: number
          booking_id: string
          created_at: string
          id: string
          material_cost_item_id: string
        }
        Insert: {
          amount_snapshot: number
          booking_id: string
          created_at?: string
          id?: string
          material_cost_item_id: string
        }
        Update: {
          amount_snapshot?: number
          booking_id?: string
          created_at?: string
          id?: string
          material_cost_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_material_costs_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_material_costs_material_cost_item_id_fkey"
            columns: ["material_cost_item_id"]
            isOneToOne: false
            referencedRelation: "material_cost_items"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_service_items: {
        Row: {
          booking_id: string
          created_at: string
          duration_minutes_snapshot: number
          id: string
          quantity: number
          service_item_id: string
          unit_price_snapshot: number
        }
        Insert: {
          booking_id: string
          created_at?: string
          duration_minutes_snapshot: number
          id?: string
          quantity?: number
          service_item_id: string
          unit_price_snapshot: number
        }
        Update: {
          booking_id?: string
          created_at?: string
          duration_minutes_snapshot?: number
          id?: string
          quantity?: number
          service_item_id?: string
          unit_price_snapshot?: number
        }
        Relationships: [
          {
            foreignKeyName: "booking_service_items_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_service_items_service_item_id_fkey"
            columns: ["service_item_id"]
            isOneToOne: false
            referencedRelation: "service_items"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        Insert: {
          cancelled_at?: string | null
          cancelled_reason?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_role: string
          created_by_user_id?: string | null
          custom_duration_enabled?: boolean
          custom_duration_minutes?: number | null
          custom_total_amount?: number | null
          custom_total_amount_enabled?: boolean
          customer_address?: string | null
          customer_email?: string | null
          customer_name: string
          customer_notes?: string | null
          customer_phone: string
          discount_amount_snapshot?: number
          discount_enabled?: boolean
          discount_mode?: string | null
          discount_value?: number | null
          end_at: string
          final_amount_snapshot?: number
          id?: string
          last_modified_at?: string | null
          last_modified_by_user_id?: string | null
          merchant_id: string
          notes?: string | null
          payment_method_id?: string | null
          payment_method_name_snapshot?: string | null
          source?: string
          staff_id: string
          start_at: string
          status?: string
          subtotal_amount_snapshot?: number
          tax_amount_snapshot?: number
          tax_enabled?: boolean
          tax_mode_snapshot?: string | null
          tax_value_snapshot?: number | null
          updated_at?: string
        }
        Update: {
          cancelled_at?: string | null
          cancelled_reason?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_role?: string
          created_by_user_id?: string | null
          custom_duration_enabled?: boolean
          custom_duration_minutes?: number | null
          custom_total_amount?: number | null
          custom_total_amount_enabled?: boolean
          customer_address?: string | null
          customer_email?: string | null
          customer_name?: string
          customer_notes?: string | null
          customer_phone?: string
          discount_amount_snapshot?: number
          discount_enabled?: boolean
          discount_mode?: string | null
          discount_value?: number | null
          end_at?: string
          final_amount_snapshot?: number
          id?: string
          last_modified_at?: string | null
          last_modified_by_user_id?: string | null
          merchant_id?: string
          notes?: string | null
          payment_method_id?: string | null
          payment_method_name_snapshot?: string | null
          source?: string
          staff_id?: string
          start_at?: string
          status?: string
          subtotal_amount_snapshot?: number
          tax_amount_snapshot?: number
          tax_enabled?: boolean
          tax_mode_snapshot?: string | null
          tax_value_snapshot?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_payment_method_id_fkey"
            columns: ["payment_method_id"]
            isOneToOne: false
            referencedRelation: "payment_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          group_admin_user_id: string | null
          id: string
          name: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_admin_user_id?: string | null
          id?: string
          name?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_admin_user_id?: string | null
          id?: string
          name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      industry_feature_presets: {
        Row: {
          default_enabled: boolean
          feature_key: string
          id: string
          industry_type: string
        }
        Insert: {
          default_enabled: boolean
          feature_key: string
          id?: string
          industry_type: string
        }
        Update: {
          default_enabled?: boolean
          feature_key?: string
          id?: string
          industry_type?: string
        }
        Relationships: []
      }
      leave_type_deduction_rules: {
        Row: {
          created_at: string
          deduction_mode: string
          fixed_amount_value: number | null
          id: string
          leave_type_id: string
          merchant_id: string
          percentage_value: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          deduction_mode?: string
          fixed_amount_value?: number | null
          id?: string
          leave_type_id: string
          merchant_id: string
          percentage_value?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          deduction_mode?: string
          fixed_amount_value?: number | null
          id?: string
          leave_type_id?: string
          merchant_id?: string
          percentage_value?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_type_deduction_rules_leave_type_id_fkey"
            columns: ["leave_type_id"]
            isOneToOne: true
            referencedRelation: "merchant_leave_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_type_deduction_rules_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      material_cost_items: {
        Row: {
          amount: number
          created_at: string
          id: string
          merchant_id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          merchant_id: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          merchant_id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_cost_items_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_admins: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          job_title: string | null
          merchant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          job_title?: string | null
          merchant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          job_title?: string | null
          merchant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_admins_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_agent_permissions: {
        Row: {
          agent_id: string
          created_at: string
          granted: boolean
          id: string
          section_key: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          granted?: boolean
          id?: string
          section_key: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          granted?: boolean
          id?: string
          section_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_agent_permissions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "merchant_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_agents: {
        Row: {
          activated_at: string | null
          contact_email: string | null
          created_at: string
          id: string
          invited_at: string
          invited_email: string
          job_title: string | null
          merchant_id: string
          name: string
          nickname: string | null
          phone: string | null
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          activated_at?: string | null
          contact_email?: string | null
          created_at?: string
          id?: string
          invited_at?: string
          invited_email: string
          job_title?: string | null
          merchant_id: string
          name: string
          nickname?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          activated_at?: string | null
          contact_email?: string | null
          created_at?: string
          id?: string
          invited_at?: string
          invited_email?: string
          job_title?: string | null
          merchant_id?: string
          name?: string
          nickname?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_agents_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_business_hours: {
        Row: {
          close_time: string | null
          created_at: string
          day_of_week: number
          id: string
          is_closed: boolean
          merchant_id: string
          open_time: string | null
          updated_at: string
        }
        Insert: {
          close_time?: string | null
          created_at?: string
          day_of_week: number
          id?: string
          is_closed?: boolean
          merchant_id: string
          open_time?: string | null
          updated_at?: string
        }
        Update: {
          close_time?: string | null
          created_at?: string
          day_of_week?: number
          id?: string
          is_closed?: boolean
          merchant_id?: string
          open_time?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_business_hours_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_feature_flags: {
        Row: {
          created_at: string
          enabled: boolean
          feature_key: string
          id: string
          merchant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled: boolean
          feature_key: string
          id?: string
          merchant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          feature_key?: string
          id?: string
          merchant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_feature_flags_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_leave_types: {
        Row: {
          created_at: string
          description: string | null
          id: string
          merchant_id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          merchant_id: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          merchant_id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_leave_types_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_payroll_settings: {
        Row: {
          commission_basis_type: string
          created_at: string
          default_commission_rate_percentage: number
          merchant_id: string
          pay_days_per_month: number
          updated_at: string
        }
        Insert: {
          commission_basis_type?: string
          created_at?: string
          default_commission_rate_percentage?: number
          merchant_id: string
          pay_days_per_month?: number
          updated_at?: string
        }
        Update: {
          commission_basis_type?: string
          created_at?: string
          default_commission_rate_percentage?: number
          merchant_id?: string
          pay_days_per_month?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_payroll_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_staff: {
        Row: {
          advance_booking_days: number | null
          auto_accept_booking: boolean
          avatar_url: string | null
          booking_window_max_days: number | null
          booking_window_min_days: number | null
          can_create_edit_orders: boolean
          can_upload_construction_photos: boolean
          compensation_type: string
          contact_email: string | null
          created_at: string
          direct_accept_after_merchant_confirm: boolean
          google_calendar_sync_enabled: boolean
          id: string
          intro: string | null
          is_listed: boolean
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          nickname: string | null
          no_time_slot_limit: boolean
          phone: string | null
          show_member_info: boolean
          status: string
          unlimited_backend_edit: boolean
          updated_at: string
          user_id: string | null
        }
        Insert: {
          advance_booking_days?: number | null
          auto_accept_booking?: boolean
          avatar_url?: string | null
          booking_window_max_days?: number | null
          booking_window_min_days?: number | null
          can_create_edit_orders?: boolean
          can_upload_construction_photos?: boolean
          compensation_type?: string
          contact_email?: string | null
          created_at?: string
          direct_accept_after_merchant_confirm?: boolean
          google_calendar_sync_enabled?: boolean
          id?: string
          intro?: string | null
          is_listed?: boolean
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id: string
          name: string
          nickname?: string | null
          no_time_slot_limit?: boolean
          phone?: string | null
          show_member_info?: boolean
          status?: string
          unlimited_backend_edit?: boolean
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          advance_booking_days?: number | null
          auto_accept_booking?: boolean
          avatar_url?: string | null
          booking_window_max_days?: number | null
          booking_window_min_days?: number | null
          can_create_edit_orders?: boolean
          can_upload_construction_photos?: boolean
          compensation_type?: string
          contact_email?: string | null
          created_at?: string
          direct_accept_after_merchant_confirm?: boolean
          google_calendar_sync_enabled?: boolean
          id?: string
          intro?: string | null
          is_listed?: boolean
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id?: string
          name?: string
          nickname?: string | null
          no_time_slot_limit?: boolean
          phone?: string | null
          show_member_info?: boolean
          status?: string
          unlimited_backend_edit?: boolean
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_staff_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_staff_service_items: {
        Row: {
          created_at: string
          id: string
          service_item_id: string
          staff_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          service_item_id: string
          staff_id: string
        }
        Update: {
          created_at?: string
          id?: string
          service_item_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_staff_service_items_service_item_id_fkey"
            columns: ["service_item_id"]
            isOneToOne: false
            referencedRelation: "service_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_staff_service_items_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_tax_settings: {
        Row: {
          created_at: string
          merchant_id: string
          tax_mode: string
          tax_value: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          merchant_id: string
          tax_mode?: string
          tax_value?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          merchant_id?: string
          tax_mode?: string
          tax_value?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_tax_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchants: {
        Row: {
          address: string | null
          announcement_content: string | null
          announcement_enabled: boolean
          booking_slug: string | null
          contact_email: string | null
          created_at: string
          group_id: string
          id: string
          industry_type: string
          intro: string | null
          logo_url: string | null
          name: string
          status: string
          theme_custom_color: string | null
          theme_preset: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          announcement_content?: string | null
          announcement_enabled?: boolean
          booking_slug?: string | null
          contact_email?: string | null
          created_at?: string
          group_id: string
          id?: string
          industry_type: string
          intro?: string | null
          logo_url?: string | null
          name: string
          status?: string
          theme_custom_color?: string | null
          theme_preset?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          announcement_content?: string | null
          announcement_enabled?: boolean
          booking_slug?: string | null
          contact_email?: string | null
          created_at?: string
          group_id?: string
          id?: string
          industry_type?: string
          intro?: string | null
          logo_url?: string | null
          name?: string
          status?: string
          theme_custom_color?: string | null
          theme_preset?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchants_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_methods: {
        Row: {
          created_at: string
          description: string | null
          id: string
          merchant_id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          merchant_id: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          merchant_id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_methods_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          created_at: string
          id: string
          note: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          note?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          note?: string | null
          user_id?: string
        }
        Relationships: []
      }
      service_categories: {
        Row: {
          created_at: string
          id: string
          merchant_id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          merchant_id: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          merchant_id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_categories_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_items: {
        Row: {
          category_id: string | null
          created_at: string
          duration_minutes: number
          id: string
          item_type: string
          merchant_id: string
          name: string
          price: number
          status: string
          updated_at: string
        }
        Insert: {
          category_id?: string | null
          created_at?: string
          duration_minutes: number
          id?: string
          item_type: string
          merchant_id: string
          name: string
          price: number
          status?: string
          updated_at?: string
        }
        Update: {
          category_id?: string | null
          created_at?: string
          duration_minutes?: number
          id?: string
          item_type?: string
          merchant_id?: string
          name?: string
          price?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "service_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_items_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_availability_overrides: {
        Row: {
          created_at: string
          id: string
          is_available: boolean
          override_date: string
          slot_start_time: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_available: boolean
          override_date: string
          slot_start_time: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_available?: boolean
          override_date?: string
          slot_start_time?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_availability_overrides_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_availability_windows: {
        Row: {
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          staff_id: string
          start_time: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          end_time: string
          id?: string
          staff_id: string
          start_time: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          staff_id?: string
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_availability_windows_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_commission_rates: {
        Row: {
          created_at: string
          id: string
          rate_percentage: number
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          rate_percentage: number
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          rate_percentage?: number
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_commission_rates_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_leave_records: {
        Row: {
          cancelled_at: string | null
          created_at: string
          created_by_user_id: string | null
          end_date: string
          id: string
          leave_type_id: string
          leave_type_name_snapshot: string
          notes: string | null
          staff_id: string
          start_date: string
          status: string
          updated_at: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          end_date: string
          id?: string
          leave_type_id: string
          leave_type_name_snapshot: string
          notes?: string | null
          staff_id: string
          start_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          end_date?: string
          id?: string
          leave_type_id?: string
          leave_type_name_snapshot?: string
          notes?: string | null
          staff_id?: string
          start_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_leave_records_leave_type_id_fkey"
            columns: ["leave_type_id"]
            isOneToOne: false
            referencedRelation: "merchant_leave_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_leave_records_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_salary_settings: {
        Row: {
          created_at: string
          id: string
          monthly_base_salary: number
          monthly_leave_quota_days: number | null
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          monthly_base_salary?: number
          monthly_leave_quota_days?: number | null
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          monthly_base_salary?: number
          monthly_leave_quota_days?: number | null
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_salary_settings_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      am_i_merchant_admin: { Args: { p_merchant_id: string }; Returns: boolean }
      am_i_platform_admin: { Args: never; Returns: boolean }
      apply_industry_preset: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      cancel_booking: {
        Args: { p_booking_id: string; p_reason?: string }
        Returns: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_staff_leave: {
        Args: { p_leave_id: string }
        Returns: {
          cancelled_at: string | null
          created_at: string
          created_by_user_id: string | null
          end_date: string
          id: string
          leave_type_id: string
          leave_type_name_snapshot: string
          notes: string | null
          staff_id: string
          start_date: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "staff_leave_records"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      clear_staff_day_override: {
        Args: {
          p_end_time: string
          p_override_date: string
          p_staff_id: string
          p_start_time: string
        }
        Returns: undefined
      }
      complete_booking: {
        Args: { p_booking_id: string }
        Returns: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      compute_booking_commission: {
        Args: { p_booking_id: string }
        Returns: undefined
      }
      confirm_booking: {
        Args: { p_booking_id: string }
        Returns: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_booking: {
        Args: {
          p_assistant_staff_ids?: string[]
          p_custom_duration_enabled?: boolean
          p_custom_duration_minutes?: number
          p_custom_total_amount?: number
          p_custom_total_amount_enabled?: boolean
          p_customer_address?: string
          p_customer_email?: string
          p_customer_name: string
          p_customer_notes?: string
          p_customer_phone: string
          p_discount_enabled?: boolean
          p_discount_mode?: string
          p_discount_value?: number
          p_material_cost_item_ids?: string[]
          p_merchant_id: string
          p_notes?: string
          p_payment_method_id?: string
          p_service_items: Json
          p_staff_id: string
          p_start_at: string
          p_tax_enabled?: boolean
          p_tax_mode?: string
          p_tax_value?: number
        }
        Returns: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_group_and_merchant: {
        Args: {
          p_address?: string
          p_contact_email?: string
          p_industry_type: string
          p_intro?: string
          p_name: string
        }
        Returns: string
      }
      create_merchant_in_group: {
        Args: {
          p_address?: string
          p_contact_email?: string
          p_group_id: string
          p_industry_type: string
          p_intro?: string
          p_name: string
        }
        Returns: string
      }
      create_staff_leave: {
        Args: {
          p_confirm_despite_conflicts?: boolean
          p_end_date: string
          p_leave_type_id: string
          p_notes?: string
          p_staff_id: string
          p_start_date: string
        }
        Returns: {
          cancelled_at: string | null
          created_at: string
          created_by_user_id: string | null
          end_date: string
          id: string
          leave_type_id: string
          leave_type_name_snapshot: string
          notes: string | null
          staff_id: string
          start_date: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "staff_leave_records"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      generate_booking_slug: { Args: { p_name: string }; Returns: string }
      get_booking_actor_names: {
        Args: { p_merchant_id: string; p_user_ids: string[] }
        Returns: {
          display_name: string
          user_id: string
        }[]
      }
      get_customer_related_bookings: {
        Args: {
          p_customer_phone: string
          p_exclude_booking_id?: string
          p_limit?: number
          p_merchant_id: string
        }
        Returns: {
          end_at: string
          final_amount_snapshot: number
          id: string
          service_item_names: string[]
          start_at: string
          status: string
        }[]
      }
      get_merchant_admin_users: {
        Args: { p_merchant_id: string }
        Returns: {
          created_at: string
          email: string
          id: string
          merchant_id: string
          user_id: string
        }[]
      }
      get_merchant_billing_summary: {
        Args: { p_merchant_id: string; p_month: number; p_year: number }
        Returns: Json
      }
      get_merchant_day_schedule: {
        Args: { p_date: string; p_merchant_id: string }
        Returns: Json
      }
      get_staff_commission_summary: {
        Args: { p_month: number; p_staff_id: string; p_year: number }
        Returns: Json
      }
      get_staff_monthly_payroll_summary: {
        Args: { p_month: number; p_staff_id: string; p_year: number }
        Returns: Json
      }
      get_staff_schedule_overview: {
        Args: {
          p_end_date: string
          p_merchant_id: string
          p_start_date: string
        }
        Returns: Json
      }
      invite_merchant_admin: {
        Args: { p_merchant_id: string; p_user_email: string }
        Returns: undefined
      }
      lookup_user_id_by_email: { Args: { p_email: string }; Returns: string }
      mark_agent_active_if_self: { Args: never; Returns: undefined }
      platform_add_merchant_admin: {
        Args: { p_merchant_id: string; p_user_email: string }
        Returns: undefined
      }
      platform_get_merchant_admin_counts: {
        Args: never
        Returns: {
          admin_count: number
          merchant_id: string
        }[]
      }
      platform_get_user_email: { Args: { p_user_id: string }; Returns: string }
      platform_remove_merchant_admin: {
        Args: { p_merchant_id: string; p_user_id: string }
        Returns: undefined
      }
      platform_set_group_admin: {
        Args: { p_group_id: string; p_user_email: string }
        Returns: undefined
      }
      preview_staff_leave_conflicts: {
        Args: { p_end_date: string; p_staff_id: string; p_start_date: string }
        Returns: {
          booking_id: string
          customer_name: string
          end_at: string
          service_item_names: string[]
          start_at: string
        }[]
      }
      recalculate_booking_commission: {
        Args: { p_booking_id: string; p_override_rate_percentage?: number }
        Returns: {
          booking_id: string
          commission_amount: number
          commission_base_amount_snapshot: number
          commission_basis_type_snapshot: string
          commission_rate_percentage_snapshot: number
          computed_at: string
          created_at: string
          id: string
          material_cost_deducted_snapshot: number
          merchant_id: string
          recalculated_at: string | null
          staff_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "booking_commission_records"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_invited_merchant_agent: {
        Args: {
          p_invited_email: string
          p_merchant_id: string
          p_name: string
          p_nickname: string
          p_phone: string
          p_status: string
          p_user_id: string
        }
        Returns: string
      }
      remove_merchant_admin: {
        Args: { p_merchant_id: string; p_user_id: string }
        Returns: undefined
      }
      remove_merchant_agent: {
        Args: { p_agent_id: string }
        Returns: undefined
      }
      seed_default_leave_deduction_rules: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      seed_default_leave_types: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      seed_default_payment_methods: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      seed_default_payroll_settings: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      set_agent_permission: {
        Args: { p_agent_id: string; p_granted: boolean; p_section_key: string }
        Returns: undefined
      }
      set_staff_day_override: {
        Args: {
          p_end_time: string
          p_is_available: boolean
          p_override_date: string
          p_staff_id: string
          p_start_time: string
        }
        Returns: number
      }
      storage_path_merchant_id: { Args: { p_path: string }; Returns: string }
      update_booking: {
        Args: {
          p_assistant_staff_ids?: string[]
          p_booking_id: string
          p_custom_duration_enabled?: boolean
          p_custom_duration_minutes?: number
          p_custom_total_amount?: number
          p_custom_total_amount_enabled?: boolean
          p_customer_address?: string
          p_customer_email?: string
          p_customer_name: string
          p_customer_notes?: string
          p_customer_phone: string
          p_discount_enabled?: boolean
          p_discount_mode?: string
          p_discount_value?: number
          p_material_cost_item_ids?: string[]
          p_notes?: string
          p_payment_method_id?: string
          p_service_items: Json
          p_staff_id: string
          p_start_at: string
          p_tax_enabled?: boolean
          p_tax_mode?: string
          p_tax_value?: number
        }
        Returns: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_booking_payment_method: {
        Args: { p_booking_id: string; p_payment_method_id?: string }
        Returns: {
          cancelled_at: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          created_by_role: string
          created_by_user_id: string | null
          custom_duration_enabled: boolean
          custom_duration_minutes: number | null
          custom_total_amount: number | null
          custom_total_amount_enabled: boolean
          customer_address: string | null
          customer_email: string | null
          customer_name: string
          customer_notes: string | null
          customer_phone: string
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          source: string
          staff_id: string
          start_at: string
          status: string
          subtotal_amount_snapshot: number
          tax_amount_snapshot: number
          tax_enabled: boolean
          tax_mode_snapshot: string | null
          tax_value_snapshot: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bookings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_my_admin_profile: {
        Args: {
          p_display_name: string
          p_job_title: string
          p_merchant_id: string
        }
        Returns: undefined
      }
      update_my_agent_profile: {
        Args: { p_job_title: string; p_merchant_id: string; p_nickname: string }
        Returns: undefined
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

