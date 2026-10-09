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
      booking_commission_item_records: {
        Row: {
          booking_service_item_id: string
          commission_amount: number
          commission_base_amount_snapshot: number
          commission_mode_snapshot: string
          commission_record_id: string
          commission_value_snapshot: number
          created_at: string
          id: string
          quantity_snapshot: number
          service_item_name_snapshot: string
        }
        Insert: {
          booking_service_item_id: string
          commission_amount: number
          commission_base_amount_snapshot?: number
          commission_mode_snapshot: string
          commission_record_id: string
          commission_value_snapshot: number
          created_at?: string
          id?: string
          quantity_snapshot: number
          service_item_name_snapshot: string
        }
        Update: {
          booking_service_item_id?: string
          commission_amount?: number
          commission_base_amount_snapshot?: number
          commission_mode_snapshot?: string
          commission_record_id?: string
          commission_value_snapshot?: number
          created_at?: string
          id?: string
          quantity_snapshot?: number
          service_item_name_snapshot?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_commission_item_records_booking_service_item_id_fkey"
            columns: ["booking_service_item_id"]
            isOneToOne: false
            referencedRelation: "booking_service_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_commission_item_records_commission_record_id_fkey"
            columns: ["commission_record_id"]
            isOneToOne: false
            referencedRelation: "booking_commission_records"
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
          commission_rate_percentage_snapshot: number | null
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
          commission_rate_percentage_snapshot?: number | null
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
          commission_rate_percentage_snapshot?: number | null
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
      booking_completion_reversals: {
        Row: {
          action: string
          actor_name_snapshot: string
          actor_user_id: string | null
          booking_id: string
          commission_amount_reversed: number
          commission_record_snapshot: Json | null
          created_at: string
          frozen_points_refunded: number
          id: string
          is_cross_month: boolean
          merchant_id: string
          notified: boolean
          original_completed_at: string
          points_due: number
          points_recovered: number
          points_shortfall: number
          reason: string
          referral_due: number
          referral_recovered: number
          referral_shortfall: number
          referrer_member_id: string | null
          report_month: string
          shortfall_hint: string | null
        }
        Insert: {
          action: string
          actor_name_snapshot: string
          actor_user_id?: string | null
          booking_id: string
          commission_amount_reversed?: number
          commission_record_snapshot?: Json | null
          created_at?: string
          frozen_points_refunded?: number
          id?: string
          is_cross_month: boolean
          merchant_id: string
          notified?: boolean
          original_completed_at: string
          points_due?: number
          points_recovered?: number
          points_shortfall?: number
          reason: string
          referral_due?: number
          referral_recovered?: number
          referral_shortfall?: number
          referrer_member_id?: string | null
          report_month: string
          shortfall_hint?: string | null
        }
        Update: {
          action?: string
          actor_name_snapshot?: string
          actor_user_id?: string | null
          booking_id?: string
          commission_amount_reversed?: number
          commission_record_snapshot?: Json | null
          created_at?: string
          frozen_points_refunded?: number
          id?: string
          is_cross_month?: boolean
          merchant_id?: string
          notified?: boolean
          original_completed_at?: string
          points_due?: number
          points_recovered?: number
          points_shortfall?: number
          reason?: string
          referral_due?: number
          referral_recovered?: number
          referral_shortfall?: number
          referrer_member_id?: string | null
          report_month?: string
          shortfall_hint?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_completion_reversals_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_completion_reversals_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
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
          quantity: number
        }
        Insert: {
          amount_snapshot: number
          booking_id: string
          created_at?: string
          id?: string
          material_cost_item_id: string
          quantity?: number
        }
        Update: {
          amount_snapshot?: number
          booking_id?: string
          created_at?: string
          id?: string
          material_cost_item_id?: string
          quantity?: number
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
      booking_status_change_logs: {
        Row: {
          actor_name_snapshot: string
          actor_role_snapshot: string
          actor_user_id: string | null
          booking_id: string
          created_at: string
          from_status: string | null
          id: string
          merchant_id: string
          note: string | null
          to_status: string
        }
        Insert: {
          actor_name_snapshot: string
          actor_role_snapshot: string
          actor_user_id?: string | null
          booking_id: string
          created_at?: string
          from_status?: string | null
          id?: string
          merchant_id: string
          note?: string | null
          to_status: string
        }
        Update: {
          actor_name_snapshot?: string
          actor_role_snapshot?: string
          actor_user_id?: string | null
          booking_id?: string
          created_at?: string
          from_status?: string | null
          id?: string
          merchant_id?: string
          note?: string | null
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_status_change_logs_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_status_change_logs_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
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
          customer_submission_id: string | null
          discount_amount_snapshot: number
          discount_enabled: boolean
          discount_mode: string | null
          discount_value: number | null
          end_at: string
          final_amount_snapshot: number
          hide_notes_from_staff: boolean
          id: string
          is_guest_booking: boolean
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
          customer_submission_id?: string | null
          discount_amount_snapshot?: number
          discount_enabled?: boolean
          discount_mode?: string | null
          discount_value?: number | null
          end_at: string
          final_amount_snapshot?: number
          hide_notes_from_staff?: boolean
          id?: string
          is_guest_booking?: boolean
          last_modified_at?: string | null
          last_modified_by_user_id?: string | null
          member_auto_created?: boolean
          member_id?: string | null
          member_name_snapshot?: string | null
          merchant_id: string
          notes?: string | null
          payment_method_id?: string | null
          payment_method_name_snapshot?: string | null
          points_planned?: number
          points_planned_auto?: number
          points_planned_breakdown?: Json
          points_planned_overridden?: boolean
          points_redeem_amount_snapshot?: number
          points_redeemed?: number
          points_review_required?: boolean
          service_description_snapshot?: string | null
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
          customer_submission_id?: string | null
          discount_amount_snapshot?: number
          discount_enabled?: boolean
          discount_mode?: string | null
          discount_value?: number | null
          end_at?: string
          final_amount_snapshot?: number
          hide_notes_from_staff?: boolean
          id?: string
          is_guest_booking?: boolean
          last_modified_at?: string | null
          last_modified_by_user_id?: string | null
          member_auto_created?: boolean
          member_id?: string | null
          member_name_snapshot?: string | null
          merchant_id?: string
          notes?: string | null
          payment_method_id?: string | null
          payment_method_name_snapshot?: string | null
          points_planned?: number
          points_planned_auto?: number
          points_planned_breakdown?: Json
          points_planned_overridden?: boolean
          points_redeem_amount_snapshot?: number
          points_redeemed?: number
          points_review_required?: boolean
          service_description_snapshot?: string | null
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
            foreignKeyName: "bookings_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
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
      customer_line_friendships: {
        Row: {
          changed_at: string
          is_friend: boolean
          line_user_id: string
          merchant_id: string
          source: string
          updated_at: string
        }
        Insert: {
          changed_at: string
          is_friend: boolean
          line_user_id: string
          merchant_id: string
          source: string
          updated_at?: string
        }
        Update: {
          changed_at?: string
          is_friend?: boolean
          line_user_id?: string
          merchant_id?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_line_friendships_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_line_identities: {
        Row: {
          display_name: string | null
          first_login_at: string
          last_login_at: string
          line_channel_id: string
          line_sub: string
          picture_url: string | null
          user_id: string
        }
        Insert: {
          display_name?: string | null
          first_login_at?: string
          last_login_at?: string
          line_channel_id: string
          line_sub: string
          picture_url?: string | null
          user_id: string
        }
        Update: {
          display_name?: string | null
          first_login_at?: string
          last_login_at?: string
          line_channel_id?: string
          line_sub?: string
          picture_url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      customer_line_login_attempts: {
        Row: {
          channel_id: string
          code_verifier: string
          consumed_at: string | null
          created_at: string
          draft: Json | null
          expires_at: string
          invite_token_hash: string | null
          ip_hash: string | null
          merchant_id: string
          nonce: string
          state_hash: string
        }
        Insert: {
          channel_id: string
          code_verifier: string
          consumed_at?: string | null
          created_at?: string
          draft?: Json | null
          expires_at: string
          invite_token_hash?: string | null
          ip_hash?: string | null
          merchant_id: string
          nonce: string
          state_hash: string
        }
        Update: {
          channel_id?: string
          code_verifier?: string
          consumed_at?: string | null
          created_at?: string
          draft?: Json | null
          expires_at?: string
          invite_token_hash?: string | null
          ip_hash?: string | null
          merchant_id?: string
          nonce?: string
          state_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_line_login_attempts_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_line_outbox: {
        Row: {
          attempts: number
          booking_id: string | null
          claimed_at: string | null
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_error: string | null
          member_id: string | null
          merchant_id: string
          payload: Json
          processed_at: string | null
          send_after: string
          status: string
          subject_user_id: string | null
        }
        Insert: {
          attempts?: number
          booking_id?: string | null
          claimed_at?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind: string
          last_error?: string | null
          member_id?: string | null
          merchant_id: string
          payload?: Json
          processed_at?: string | null
          send_after?: string
          status?: string
          subject_user_id?: string | null
        }
        Update: {
          attempts?: number
          booking_id?: string | null
          claimed_at?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          member_id?: string | null
          merchant_id?: string
          payload?: Json
          processed_at?: string | null
          send_after?: string
          status?: string
          subject_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_line_outbox_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_line_outbox_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_member_link_blocks: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          member_id: string
          merchant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          member_id: string
          merchant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          member_id?: string
          merchant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_member_link_blocks_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_member_link_blocks_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_policy_consents: {
        Row: {
          consented_at: string
          context: string
          id: string
          member_id: string | null
          member_policy_enabled: boolean
          member_policy_hash: string | null
          merchant_id: string
          phone_normalized: string | null
          privacy_policy_version: string
          user_id: string | null
        }
        Insert: {
          consented_at?: string
          context: string
          id?: string
          member_id?: string | null
          member_policy_enabled: boolean
          member_policy_hash?: string | null
          merchant_id: string
          phone_normalized?: string | null
          privacy_policy_version: string
          user_id?: string | null
        }
        Update: {
          consented_at?: string
          context?: string
          id?: string
          member_id?: string | null
          member_policy_enabled?: boolean
          member_policy_hash?: string | null
          merchant_id?: string
          phone_normalized?: string | null
          privacy_policy_version?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_policy_consents_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_policy_consents_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
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
        Relationships: [
          {
            foreignKeyName: "industry_feature_presets_feature_key_fkey"
            columns: ["feature_key"]
            isOneToOne: false
            referencedRelation: "platform_features"
            referencedColumns: ["key"]
          },
        ]
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
      line_binding_codes: {
        Row: {
          code: string
          created_at: string
          created_by_user_id: string | null
          expires_at: string
          id: string
          merchant_id: string
          target_id: string
          target_type: string
          used_at: string | null
          used_by_line_user_id: string | null
        }
        Insert: {
          code: string
          created_at?: string
          created_by_user_id?: string | null
          expires_at: string
          id?: string
          merchant_id: string
          target_id: string
          target_type: string
          used_at?: string | null
          used_by_line_user_id?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by_user_id?: string | null
          expires_at?: string
          id?: string
          merchant_id?: string
          target_id?: string
          target_type?: string
          used_at?: string | null
          used_by_line_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "line_binding_codes_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      line_notification_log: {
        Row: {
          attempted_at: string
          booking_id: string | null
          created_by_user_id: string | null
          error_detail: string | null
          event_type: string
          id: string
          merchant_id: string
          outbox_id: string | null
          rendered_message: string | null
          skip_reason: string | null
          staff_leave_record_id: string | null
          status: string
          target_id: string | null
          target_line_user_id: string | null
          target_type: string
          target_user_id: string | null
        }
        Insert: {
          attempted_at?: string
          booking_id?: string | null
          created_by_user_id?: string | null
          error_detail?: string | null
          event_type: string
          id?: string
          merchant_id: string
          outbox_id?: string | null
          rendered_message?: string | null
          skip_reason?: string | null
          staff_leave_record_id?: string | null
          status: string
          target_id?: string | null
          target_line_user_id?: string | null
          target_type: string
          target_user_id?: string | null
        }
        Update: {
          attempted_at?: string
          booking_id?: string | null
          created_by_user_id?: string | null
          error_detail?: string | null
          event_type?: string
          id?: string
          merchant_id?: string
          outbox_id?: string | null
          rendered_message?: string | null
          skip_reason?: string | null
          staff_leave_record_id?: string | null
          status?: string
          target_id?: string | null
          target_line_user_id?: string | null
          target_type?: string
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "line_notification_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "line_notification_log_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "line_notification_log_staff_leave_record_id_fkey"
            columns: ["staff_leave_record_id"]
            isOneToOne: false
            referencedRelation: "staff_leave_records"
            referencedColumns: ["id"]
          },
        ]
      }
      line_webhook_events: {
        Row: {
          line_event_type: string | null
          merchant_id: string | null
          note: string | null
          processed_at: string
          webhook_event_id: string
        }
        Insert: {
          line_event_type?: string | null
          merchant_id?: string | null
          note?: string | null
          processed_at?: string
          webhook_event_id: string
        }
        Update: {
          line_event_type?: string | null
          merchant_id?: string | null
          note?: string | null
          processed_at?: string
          webhook_event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "line_webhook_events_merchant_id_fkey"
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
      member_birthday_bonus_grants: {
        Row: {
          anchor_date: string
          bonus_year: number
          granted_at: string
          id: string
          line_attempted_at: string | null
          line_error: string | null
          line_notification_log_id: string | null
          line_status: string
          member_id: string
          member_name_snapshot: string
          merchant_id: string
          point_transaction_id: string
          points: number
        }
        Insert: {
          anchor_date: string
          bonus_year: number
          granted_at?: string
          id?: string
          line_attempted_at?: string | null
          line_error?: string | null
          line_notification_log_id?: string | null
          line_status?: string
          member_id: string
          member_name_snapshot: string
          merchant_id: string
          point_transaction_id: string
          points: number
        }
        Update: {
          anchor_date?: string
          bonus_year?: number
          granted_at?: string
          id?: string
          line_attempted_at?: string | null
          line_error?: string | null
          line_notification_log_id?: string | null
          line_status?: string
          member_id?: string
          member_name_snapshot?: string
          merchant_id?: string
          point_transaction_id?: string
          points?: number
        }
        Relationships: [
          {
            foreignKeyName: "member_birthday_bonus_grants_line_notification_log_id_fkey"
            columns: ["line_notification_log_id"]
            isOneToOne: false
            referencedRelation: "line_notification_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_birthday_bonus_grants_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_birthday_bonus_grants_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_birthday_bonus_grants_point_transaction_id_fkey"
            columns: ["point_transaction_id"]
            isOneToOne: false
            referencedRelation: "member_point_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      member_point_transactions: {
        Row: {
          balance_after: number
          booking_id: string | null
          created_at: string
          created_by_user_id: string | null
          id: string
          member_id: string
          merchant_id: string
          note: string | null
          points_delta: number
          related_member_id: string | null
          transaction_type: string
        }
        Insert: {
          balance_after: number
          booking_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          member_id: string
          merchant_id: string
          note?: string | null
          points_delta: number
          related_member_id?: string | null
          transaction_type: string
        }
        Update: {
          balance_after?: number
          booking_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          member_id?: string
          merchant_id?: string
          note?: string | null
          points_delta?: number
          related_member_id?: string | null
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_point_transactions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_point_transactions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_point_transactions_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_point_transactions_related_member_id_fkey"
            columns: ["related_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_contact_invite_claims: {
        Row: {
          created_at: string
          expires_at: string
          invite_id: string
          merchant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          invite_id: string
          merchant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          invite_id?: string
          merchant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_contact_invite_claims_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "member_contact_invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_contact_invite_claims_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      member_contact_invites: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          expires_at: string
          id: string
          member_id: string
          merchant_id: string
          revoked_at: string | null
          revoked_by_user_id: string | null
          token_hash: string
          used_at: string | null
          used_by_user_id: string | null
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          expires_at: string
          id?: string
          member_id: string
          merchant_id: string
          revoked_at?: string | null
          revoked_by_user_id?: string | null
          token_hash: string
          used_at?: string | null
          used_by_user_id?: string | null
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          expires_at?: string
          id?: string
          member_id?: string
          merchant_id?: string
          revoked_at?: string | null
          revoked_by_user_id?: string | null
          token_hash?: string
          used_at?: string | null
          used_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "member_contact_invites_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_contact_invites_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      member_contact_requests: {
        Row: {
          created_at: string
          id: string
          member_id: string
          merchant_id: string
          phone_normalized: string
          resolved_at: string | null
          resolved_by_role: string | null
          resolved_by_user_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          member_id: string
          merchant_id: string
          phone_normalized: string
          resolved_at?: string | null
          resolved_by_role?: string | null
          resolved_by_user_id?: string | null
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          member_id?: string
          merchant_id?: string
          phone_normalized?: string
          resolved_at?: string | null
          resolved_by_role?: string | null
          resolved_by_user_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_contact_requests_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_contact_requests_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      member_customer_contacts: {
        Row: {
          contact_phone: string | null
          created_at: string
          id: string
          is_primary: boolean
          joined_via: string
          member_id: string
          merchant_id: string
          notify_booking: boolean
          notify_prefs_updated_at: string | null
          notify_promo: boolean
          removed_at: string | null
          removed_by_user_id: string | null
          removed_via: string | null
          status: string
          user_id: string
        }
        Insert: {
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean
          joined_via: string
          member_id: string
          merchant_id: string
          notify_booking?: boolean
          notify_prefs_updated_at?: string | null
          notify_promo?: boolean
          removed_at?: string | null
          removed_by_user_id?: string | null
          removed_via?: string | null
          status?: string
          user_id: string
        }
        Update: {
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean
          joined_via?: string
          member_id?: string
          merchant_id?: string
          notify_booking?: boolean
          notify_prefs_updated_at?: string | null
          notify_promo?: boolean
          removed_at?: string | null
          removed_by_user_id?: string | null
          removed_via?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_customer_contacts_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_customer_contacts_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          address?: string | null
          birthday?: string | null
          blacklist_reason?: string | null
          blacklisted_at?: string | null
          blacklisted_by_user_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          email?: string | null
          id?: string
          identity_first_verified_at?: string | null
          identity_verified_at?: string | null
          identity_verified_via?: string | null
          is_blacklisted?: boolean
          last_birthday_bonus_year?: number | null
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id: string
          name: string
          notes?: string | null
          phone?: string | null
          phone_verified?: boolean
          phone_verified_at?: string | null
          points_balance?: number
          referral_code: string
          referral_rewarded_at?: string | null
          referred_by_member_id?: string | null
          status?: string
          tier_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          address?: string | null
          birthday?: string | null
          blacklist_reason?: string | null
          blacklisted_at?: string | null
          blacklisted_by_user_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          email?: string | null
          id?: string
          identity_first_verified_at?: string | null
          identity_verified_at?: string | null
          identity_verified_via?: string | null
          is_blacklisted?: boolean
          last_birthday_bonus_year?: number | null
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          phone_verified?: boolean
          phone_verified_at?: string | null
          points_balance?: number
          referral_code?: string
          referral_rewarded_at?: string | null
          referred_by_member_id?: string | null
          status?: string
          tier_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "members_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_referred_by_member_id_fkey"
            columns: ["referred_by_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "merchant_member_tiers"
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
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          phone: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          job_title?: string | null
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id: string
          phone?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          job_title?: string | null
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id?: string
          phone?: string | null
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
          created_at: string
          id: string
          invited_at: string
          invited_email: string
          job_title: string | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          nickname: string | null
          pending_admin_login_email: string | null
          pending_admin_login_email_requested_at: string | null
          pending_admin_login_email_requested_by: string | null
          phone: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          activated_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string
          invited_email: string
          job_title?: string | null
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id: string
          name: string
          nickname?: string | null
          pending_admin_login_email?: string | null
          pending_admin_login_email_requested_at?: string | null
          pending_admin_login_email_requested_by?: string | null
          phone: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          activated_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string
          invited_email?: string
          job_title?: string | null
          line_bound?: boolean
          line_user_id?: string | null
          merchant_id?: string
          name?: string
          nickname?: string | null
          pending_admin_login_email?: string | null
          pending_admin_login_email_requested_at?: string | null
          pending_admin_login_email_requested_by?: string | null
          phone?: string
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
      merchant_booking_status_colors: {
        Row: {
          accepted_color: string
          cancelled_color: string
          completed_color: string
          created_at: string
          merchant_id: string
          pending_confirmation_color: string
          updated_at: string
        }
        Insert: {
          accepted_color?: string
          cancelled_color?: string
          completed_color?: string
          created_at?: string
          merchant_id: string
          pending_confirmation_color?: string
          updated_at?: string
        }
        Update: {
          accepted_color?: string
          cancelled_color?: string
          completed_color?: string
          created_at?: string
          merchant_id?: string
          pending_confirmation_color?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_booking_status_colors_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_bulk_operation_items: {
        Row: {
          action: string
          created_at: string
          entity_id: string
          entity_table: string
          id: string
          operation_id: string
        }
        Insert: {
          action: string
          created_at?: string
          entity_id: string
          entity_table: string
          id?: string
          operation_id: string
        }
        Update: {
          action?: string
          created_at?: string
          entity_id?: string
          entity_table?: string
          id?: string
          operation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_bulk_operation_items_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "merchant_bulk_operations"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_bulk_operations: {
        Row: {
          column_mapping: Json | null
          created_at: string
          created_by_user_id: string | null
          error_report: Json
          failed_rows: number
          id: string
          merchant_id: string
          operation_type: string
          pre_operation_snapshot: Json
          related_merchant_id: string | null
          rolled_back_at: string | null
          rolled_back_by_user_id: string | null
          skipped_duplicate_rows: number
          status: string
          success_rows: number
          total_rows: number
          write_mode: string | null
        }
        Insert: {
          column_mapping?: Json | null
          created_at?: string
          created_by_user_id?: string | null
          error_report?: Json
          failed_rows?: number
          id?: string
          merchant_id: string
          operation_type: string
          pre_operation_snapshot?: Json
          related_merchant_id?: string | null
          rolled_back_at?: string | null
          rolled_back_by_user_id?: string | null
          skipped_duplicate_rows?: number
          status?: string
          success_rows?: number
          total_rows?: number
          write_mode?: string | null
        }
        Update: {
          column_mapping?: Json | null
          created_at?: string
          created_by_user_id?: string | null
          error_report?: Json
          failed_rows?: number
          id?: string
          merchant_id?: string
          operation_type?: string
          pre_operation_snapshot?: Json
          related_merchant_id?: string | null
          rolled_back_at?: string | null
          rolled_back_by_user_id?: string | null
          skipped_duplicate_rows?: number
          status?: string
          success_rows?: number
          total_rows?: number
          write_mode?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_bulk_operations_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_bulk_operations_related_merchant_id_fkey"
            columns: ["related_merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_booking_settings: {
        Row: {
          allow_guest_booking: boolean
          completion_message_guest: string | null
          completion_message_member: string | null
          customer_cancel_deadline_hours: number
          merchant_id: string
          min_lead_hours: number
          start_time_interval_minutes: number
          travel_buffer_minutes: number
        }
        Insert: {
          allow_guest_booking?: boolean
          completion_message_guest?: string | null
          completion_message_member?: string | null
          customer_cancel_deadline_hours?: number
          merchant_id: string
          min_lead_hours?: number
          start_time_interval_minutes?: number
          travel_buffer_minutes?: number
        }
        Update: {
          allow_guest_booking?: boolean
          completion_message_guest?: string | null
          completion_message_member?: string | null
          customer_cancel_deadline_hours?: number
          merchant_id?: string
          min_lead_hours?: number
          start_time_interval_minutes?: number
          travel_buffer_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "merchant_booking_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
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
      merchant_calendar_state_styles: {
        Row: {
          color: string
          created_at: string
          merchant_id: string
          opacity: number
          state_type: string
          updated_at: string
        }
        Insert: {
          color: string
          created_at?: string
          merchant_id: string
          opacity?: number
          state_type: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          merchant_id?: string
          opacity?: number
          state_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_calendar_state_styles_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_customer_line_settings: {
        Row: {
          created_at: string
          merchant_id: string
          monthly_cap: number | null
          on_cancelled_by_customer: boolean
          on_cancelled_by_store: boolean
          on_completed: boolean
          on_confirmed: boolean
          on_contact_events: boolean
          on_reminder: boolean
          on_rescheduled: boolean
          on_scheduled_by_store: boolean
          on_submitted: boolean
          quota_blocked_until: string | null
          quota_checked_at: string | null
          quota_warned_month: string | null
          reminder_hours_before: number
          templates: Json
          updated_at: string
          updated_by_user_id: string | null
        }
        Insert: {
          created_at?: string
          merchant_id: string
          monthly_cap?: number | null
          on_cancelled_by_customer?: boolean
          on_cancelled_by_store?: boolean
          on_completed?: boolean
          on_confirmed?: boolean
          on_contact_events?: boolean
          on_reminder?: boolean
          on_rescheduled?: boolean
          on_scheduled_by_store?: boolean
          on_submitted?: boolean
          quota_blocked_until?: string | null
          quota_checked_at?: string | null
          quota_warned_month?: string | null
          reminder_hours_before?: number
          templates?: Json
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Update: {
          created_at?: string
          merchant_id?: string
          monthly_cap?: number | null
          on_cancelled_by_customer?: boolean
          on_cancelled_by_store?: boolean
          on_completed?: boolean
          on_confirmed?: boolean
          on_contact_events?: boolean
          on_reminder?: boolean
          on_rescheduled?: boolean
          on_scheduled_by_store?: boolean
          on_submitted?: boolean
          quota_blocked_until?: string | null
          quota_checked_at?: string | null
          quota_warned_month?: string | null
          reminder_hours_before?: number
          templates?: Json
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_customer_line_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
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
      merchant_feature_grant_logs: {
        Row: {
          changed_by: string
          created_at: string
          feature_key: string
          id: string
          is_bulk: boolean
          merchant_id: string
          new_enabled: boolean
          note: string | null
          old_enabled: boolean | null
        }
        Insert: {
          changed_by: string
          created_at?: string
          feature_key: string
          id?: string
          is_bulk?: boolean
          merchant_id: string
          new_enabled: boolean
          note?: string | null
          old_enabled?: boolean | null
        }
        Update: {
          changed_by?: string
          created_at?: string
          feature_key?: string
          id?: string
          is_bulk?: boolean
          merchant_id?: string
          new_enabled?: boolean
          note?: string | null
          old_enabled?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_feature_grant_logs_feature_key_fkey"
            columns: ["feature_key"]
            isOneToOne: false
            referencedRelation: "platform_features"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "merchant_feature_grant_logs_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_feature_grants: {
        Row: {
          enabled: boolean
          feature_key: string
          merchant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled: boolean
          feature_key: string
          merchant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          feature_key?: string
          merchant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_feature_grants_feature_key_fkey"
            columns: ["feature_key"]
            isOneToOne: false
            referencedRelation: "platform_features"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "merchant_feature_grants_merchant_id_fkey"
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
      merchant_line_configs: {
        Row: {
          channel_access_token: string
          channel_id: string
          channel_secret: string
          created_at: string
          display_name: string | null
          is_connected: boolean
          last_test_result: string | null
          last_tested_at: string | null
          line_bot_basic_id: string | null
          line_bot_user_id: string | null
          merchant_id: string
          updated_at: string
        }
        Insert: {
          channel_access_token: string
          channel_id: string
          channel_secret: string
          created_at?: string
          display_name?: string | null
          is_connected?: boolean
          last_test_result?: string | null
          last_tested_at?: string | null
          line_bot_basic_id?: string | null
          line_bot_user_id?: string | null
          merchant_id: string
          updated_at?: string
        }
        Update: {
          channel_access_token?: string
          channel_id?: string
          channel_secret?: string
          created_at?: string
          display_name?: string | null
          is_connected?: boolean
          last_test_result?: string | null
          last_tested_at?: string | null
          line_bot_basic_id?: string | null
          line_bot_user_id?: string | null
          merchant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_line_configs_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_line_event_settings: {
        Row: {
          created_at: string
          enabled: boolean
          event_type: string
          id: string
          merchant_id: string
          message_template: string
          notify_admin: boolean
          notify_agent: boolean
          notify_member: boolean
          notify_staff: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          event_type: string
          id?: string
          merchant_id: string
          message_template?: string
          notify_admin?: boolean
          notify_agent?: boolean
          notify_member?: boolean
          notify_staff?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          event_type?: string
          id?: string
          merchant_id?: string
          message_template?: string
          notify_admin?: boolean
          notify_agent?: boolean
          notify_member?: boolean
          notify_staff?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_line_event_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_line_login_configs: {
        Row: {
          channel_id: string
          channel_secret_last4: string
          channel_secret_vault_id: string
          created_at: string
          enabled: boolean
          last_login_succeeded_at: string | null
          linked_oa_status: string | null
          merchant_id: string
          updated_at: string
          updated_by_user_id: string | null
        }
        Insert: {
          channel_id: string
          channel_secret_last4: string
          channel_secret_vault_id: string
          created_at?: string
          enabled?: boolean
          last_login_succeeded_at?: string | null
          linked_oa_status?: string | null
          merchant_id: string
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Update: {
          channel_id?: string
          channel_secret_last4?: string
          channel_secret_vault_id?: string
          created_at?: string
          enabled?: boolean
          last_login_succeeded_at?: string | null
          linked_oa_status?: string | null
          merchant_id?: string
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_line_login_configs_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_member_settings: {
        Row: {
          basic_min_amount: number
          basic_points_per_order: number
          basic_tiered_enabled: boolean
          birthday_bonus_enabled: boolean
          birthday_bonus_points: number
          birthday_line_message: string
          created_at: string
          earn_mode: string
          merchant_id: string
          points_feature_enabled: boolean
          policy_content: string | null
          policy_enabled: boolean
          redeem_amount_unit: number
          redeem_max_ratio_percent: number
          redeem_points_unit: number
          referral_bonus_points: number
          referral_invitee_earning_enabled: boolean
          referral_inviter_earning_enabled: boolean
          referral_inviter_reward_enabled: boolean
          referral_subsequent_bonus_points: number
          reward_condition_mode: string
          updated_at: string
        }
        Insert: {
          basic_min_amount?: number
          basic_points_per_order?: number
          basic_tiered_enabled?: boolean
          birthday_bonus_enabled?: boolean
          birthday_bonus_points?: number
          birthday_line_message?: string
          created_at?: string
          earn_mode?: string
          merchant_id: string
          points_feature_enabled?: boolean
          policy_content?: string | null
          policy_enabled?: boolean
          redeem_amount_unit?: number
          redeem_max_ratio_percent?: number
          redeem_points_unit?: number
          referral_bonus_points?: number
          referral_invitee_earning_enabled?: boolean
          referral_inviter_earning_enabled?: boolean
          referral_inviter_reward_enabled?: boolean
          referral_subsequent_bonus_points?: number
          reward_condition_mode?: string
          updated_at?: string
        }
        Update: {
          basic_min_amount?: number
          basic_points_per_order?: number
          basic_tiered_enabled?: boolean
          birthday_bonus_enabled?: boolean
          birthday_bonus_points?: number
          birthday_line_message?: string
          created_at?: string
          earn_mode?: string
          merchant_id?: string
          points_feature_enabled?: boolean
          policy_content?: string | null
          policy_enabled?: boolean
          redeem_amount_unit?: number
          redeem_max_ratio_percent?: number
          redeem_points_unit?: number
          referral_bonus_points?: number
          referral_invitee_earning_enabled?: boolean
          referral_inviter_earning_enabled?: boolean
          referral_inviter_reward_enabled?: boolean
          referral_subsequent_bonus_points?: number
          reward_condition_mode?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_member_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_member_tiers: {
        Row: {
          created_at: string
          id: string
          merchant_id: string
          name: string
          sort_order: number
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          merchant_id: string
          name: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          merchant_id?: string
          name?: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_member_tiers_merchant_id_fkey"
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
          merchant_id: string
          updated_at: string
        }
        Insert: {
          commission_basis_type?: string
          created_at?: string
          merchant_id: string
          updated_at?: string
        }
        Update: {
          commission_basis_type?: string
          created_at?: string
          merchant_id?: string
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
      merchant_point_formulas: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          merchant_id: string
          min_unit_price: number
          name: string
          points_per_unit: number
          service_item_id: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          merchant_id: string
          min_unit_price?: number
          name: string
          points_per_unit: number
          service_item_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          merchant_id?: string
          min_unit_price?: number
          name?: string
          points_per_unit?: number
          service_item_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_point_formulas_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_point_formulas_service_item_id_fkey"
            columns: ["service_item_id"]
            isOneToOne: false
            referencedRelation: "service_items"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_points_feature_history: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          enabled: boolean
          id: string
          is_backfill_seed: boolean
          merchant_id: string
        }
        Insert: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          enabled: boolean
          id?: string
          is_backfill_seed?: boolean
          merchant_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          enabled?: boolean
          id?: string
          is_backfill_seed?: boolean
          merchant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_points_feature_history_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_push_event_settings: {
        Row: {
          created_at: string
          enabled: boolean
          event_type: string
          id: string
          merchant_id: string
          message_body: string
          message_title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          event_type: string
          id?: string
          merchant_id: string
          message_body?: string
          message_title?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          event_type?: string
          id?: string
          merchant_id?: string
          message_body?: string
          message_title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_push_event_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
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
          can_create_edit_orders: boolean
          can_upload_construction_photos: boolean
          compensation_type: string
          created_at: string
          direct_accept_after_merchant_confirm: boolean
          display_order: number
          google_calendar_sync_enabled: boolean
          id: string
          intro: string | null
          invited_login_email: string | null
          is_listed: boolean
          line_bound: boolean
          line_user_id: string | null
          login_activated_at: string | null
          login_invited_at: string | null
          login_status: string
          merchant_id: string
          name: string
          nickname: string | null
          no_time_slot_limit: boolean
          pending_admin_login_email: string | null
          pending_admin_login_email_requested_at: string | null
          pending_admin_login_email_requested_by: string | null
          phone: string
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
          can_create_edit_orders?: boolean
          can_upload_construction_photos?: boolean
          compensation_type?: string
          created_at?: string
          direct_accept_after_merchant_confirm?: boolean
          display_order?: number
          google_calendar_sync_enabled?: boolean
          id?: string
          intro?: string | null
          invited_login_email?: string | null
          is_listed?: boolean
          line_bound?: boolean
          line_user_id?: string | null
          login_activated_at?: string | null
          login_invited_at?: string | null
          login_status?: string
          merchant_id: string
          name: string
          nickname?: string | null
          no_time_slot_limit?: boolean
          pending_admin_login_email?: string | null
          pending_admin_login_email_requested_at?: string | null
          pending_admin_login_email_requested_by?: string | null
          phone: string
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
          can_create_edit_orders?: boolean
          can_upload_construction_photos?: boolean
          compensation_type?: string
          created_at?: string
          direct_accept_after_merchant_confirm?: boolean
          display_order?: number
          google_calendar_sync_enabled?: boolean
          id?: string
          intro?: string | null
          invited_login_email?: string | null
          is_listed?: boolean
          line_bound?: boolean
          line_user_id?: string | null
          login_activated_at?: string | null
          login_invited_at?: string | null
          login_status?: string
          merchant_id?: string
          name?: string
          nickname?: string | null
          no_time_slot_limit?: boolean
          pending_admin_login_email?: string | null
          pending_admin_login_email_requested_at?: string | null
          pending_admin_login_email_requested_by?: string | null
          phone?: string
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
      merchant_staff_permissions: {
        Row: {
          created_at: string
          granted: boolean
          id: string
          section_key: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          granted?: boolean
          id?: string
          section_key: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          granted?: boolean
          id?: string
          section_key?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_staff_permissions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
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
          line_friend_url: string | null
          logo_url: string | null
          name: string
          phone: string | null
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
          line_friend_url?: string | null
          logo_url?: string | null
          name: string
          phone?: string | null
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
          line_friend_url?: string | null
          logo_url?: string | null
          name?: string
          phone?: string | null
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
      platform_features: {
        Row: {
          created_at: string
          default_enabled: boolean
          description: string
          key: string
          name: string
          off_impact: string
          parent_key: string | null
          sort_order: number
        }
        Insert: {
          created_at?: string
          default_enabled: boolean
          description: string
          key: string
          name: string
          off_impact: string
          parent_key?: string | null
          sort_order: number
        }
        Update: {
          created_at?: string
          default_enabled?: boolean
          description?: string
          key?: string
          name?: string
          off_impact?: string
          parent_key?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "platform_features_parent_key_fkey"
            columns: ["parent_key"]
            isOneToOne: false
            referencedRelation: "platform_features"
            referencedColumns: ["key"]
          },
        ]
      }
      push_event_subscriptions: {
        Row: {
          created_at: string
          enabled: boolean
          event_type: string
          id: string
          merchant_id: string
          target_id: string
          target_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          event_type: string
          id?: string
          merchant_id: string
          target_id: string
          target_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          event_type?: string
          id?: string
          merchant_id?: string
          target_id?: string
          target_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_event_subscriptions_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      push_notification_log: {
        Row: {
          ack_subscription_id: string | null
          ack_token: string | null
          acked_at: string | null
          attempted_at: string
          booking_id: string | null
          device_count: number
          error_detail: string | null
          event_type: string
          id: string
          merchant_id: string
          rendered_body: string | null
          rendered_title: string | null
          skip_reason: string | null
          status: string
          success_count: number
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          ack_subscription_id?: string | null
          ack_token?: string | null
          acked_at?: string | null
          attempted_at?: string
          booking_id?: string | null
          device_count?: number
          error_detail?: string | null
          event_type: string
          id?: string
          merchant_id: string
          rendered_body?: string | null
          rendered_title?: string | null
          skip_reason?: string | null
          status: string
          success_count?: number
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          ack_subscription_id?: string | null
          ack_token?: string | null
          acked_at?: string | null
          attempted_at?: string
          booking_id?: string | null
          device_count?: number
          error_detail?: string | null
          event_type?: string
          id?: string
          merchant_id?: string
          rendered_body?: string | null
          rendered_title?: string | null
          skip_reason?: string | null
          status?: string
          success_count?: number
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_notification_log_ack_subscription_id_fkey"
            columns: ["ack_subscription_id"]
            isOneToOne: false
            referencedRelation: "push_subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_notification_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_notification_log_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      push_reminder_dedupe_log: {
        Row: {
          booking_id: string
          reminder_date: string
          sent_at: string
        }
        Insert: {
          booking_id: string
          reminder_date: string
          sent_at?: string
        }
        Update: {
          booking_id?: string
          reminder_date?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_reminder_dedupe_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth_key: string
          created_at: string
          endpoint: string
          id: string
          last_seen_at: string | null
          p256dh_key: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth_key: string
          created_at?: string
          endpoint: string
          id?: string
          last_seen_at?: string | null
          p256dh_key: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth_key?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_seen_at?: string | null
          p256dh_key?: string
          user_agent?: string | null
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
          description: string | null
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
          description?: string | null
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
          description?: string | null
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
      staff_bonus_assignments: {
        Row: {
          created_at: string
          merchant_id: string
          plan_id: string | null
          staff_id: string
          updated_at: string
          updated_by_user_id: string | null
        }
        Insert: {
          created_at?: string
          merchant_id: string
          plan_id?: string | null
          staff_id: string
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Update: {
          created_at?: string
          merchant_id?: string
          plan_id?: string | null
          staff_id?: string
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_bonus_assignments_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_bonus_assignments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "staff_bonus_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_bonus_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_bonus_plan_versions: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          effective_month: string
          id: string
          merchant_id: string
          plan_id: string
          rules: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          effective_month: string
          id?: string
          merchant_id: string
          plan_id: string
          rules: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          effective_month?: string
          id?: string
          merchant_id?: string
          plan_id?: string
          rules?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_bonus_plan_versions_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_bonus_plan_versions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "staff_bonus_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_bonus_plans: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          id: string
          merchant_id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          merchant_id: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          merchant_id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_bonus_plans_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
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
      staff_payroll_status_history: {
        Row: {
          bonus_plan_id: string | null
          compensation_type: string
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          is_backfill_seed: boolean
          merchant_id: string
          monthly_base_salary: number
          staff_id: string
          status: string
          wage_amount: number | null
        }
        Insert: {
          bonus_plan_id?: string | null
          compensation_type: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          is_backfill_seed?: boolean
          merchant_id: string
          monthly_base_salary?: number
          staff_id: string
          status: string
          wage_amount?: number | null
        }
        Update: {
          bonus_plan_id?: string | null
          compensation_type?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          is_backfill_seed?: boolean
          merchant_id?: string
          monthly_base_salary?: number
          staff_id?: string
          status?: string
          wage_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_payroll_status_history_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_payroll_status_history_staff_id_fkey"
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
      staff_service_commission_rates: {
        Row: {
          commission_mode: string
          commission_value: number
          created_at: string
          id: string
          service_item_id: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          commission_mode?: string
          commission_value?: number
          created_at?: string
          id?: string
          service_item_id: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          commission_mode?: string
          commission_value?: number
          created_at?: string
          id?: string
          service_item_id?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_service_commission_rates_service_item_id_fkey"
            columns: ["service_item_id"]
            isOneToOne: false
            referencedRelation: "service_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_service_commission_rates_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_wage_settings: {
        Row: {
          created_at: string
          merchant_id: string
          staff_id: string
          updated_at: string
          updated_by_user_id: string | null
          wage_amount: number
        }
        Insert: {
          created_at?: string
          merchant_id: string
          staff_id: string
          updated_at?: string
          updated_by_user_id?: string | null
          wage_amount: number
        }
        Update: {
          created_at?: string
          merchant_id?: string
          staff_id?: string
          updated_at?: string
          updated_by_user_id?: string | null
          wage_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_wage_settings_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_wage_settings_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_work_day_records: {
        Row: {
          compensation_type: string
          created_at: string
          extra_booking_minutes: number
          frozen_at: string
          id: string
          is_leave: boolean
          leave_type_name: string | null
          merchant_id: string
          pay_amount: number
          refrozen_reason: string | null
          shift_minutes: number
          staff_id: string
          updated_at: string
          wage_amount: number
          work_date: string
          worked_minutes: number
        }
        Insert: {
          compensation_type: string
          created_at?: string
          extra_booking_minutes: number
          frozen_at?: string
          id?: string
          is_leave?: boolean
          leave_type_name?: string | null
          merchant_id: string
          pay_amount: number
          refrozen_reason?: string | null
          shift_minutes: number
          staff_id: string
          updated_at?: string
          wage_amount: number
          work_date: string
          worked_minutes: number
        }
        Update: {
          compensation_type?: string
          created_at?: string
          extra_booking_minutes?: number
          frozen_at?: string
          id?: string
          is_leave?: boolean
          leave_type_name?: string | null
          merchant_id?: string
          pay_amount?: number
          refrozen_reason?: string | null
          shift_minutes?: number
          staff_id?: string
          updated_at?: string
          wage_amount?: number
          work_date?: string
          worked_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_work_day_records_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_work_day_records_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "merchant_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      user_notifications: {
        Row: {
          body: string
          booking_id: string | null
          created_at: string
          event_type: string
          id: string
          merchant_id: string
          read_at: string | null
          target_id: string
          target_type: string
          title: string
          user_id: string
        }
        Insert: {
          body: string
          booking_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          merchant_id: string
          read_at?: string | null
          target_id: string
          target_type: string
          title: string
          user_id: string
        }
        Update: {
          body?: string
          booking_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          merchant_id?: string
          read_at?: string | null
          target_id?: string
          target_type?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_notifications_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_notifications_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ack_push_test_notification: {
        Args: { p_ack_token: string }
        Returns: boolean
      }
      adjust_member_points: {
        Args: { p_member_id: string; p_note: string; p_points_delta: number }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      allow_member_customer_relink: {
        Args: { p_member_id: string }
        Returns: number
      }
      am_i_allowed_line_marketing: {
        Args: { p_merchant_id: string }
        Returns: boolean
      }
      am_i_merchant_admin: { Args: { p_merchant_id: string }; Returns: boolean }
      am_i_platform_admin: { Args: never; Returns: boolean }
      apply_industry_preset: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      archive_staff_bonus_plan: {
        Args: { p_plan_id: string }
        Returns: undefined
      }
      batch_apply_staff_service_commission_rates: {
        Args: {
          p_commission_mode: string
          p_commission_value: number
          p_service_item_ids: string[]
          p_staff_id: string
        }
        Returns: undefined
      }
      can_dispatch_line_notification: {
        Args: { p_event_type: string; p_merchant_id: string }
        Returns: boolean
      }
      can_manage_bookings: { Args: { p_merchant_id: string }; Returns: boolean }
      can_staff_dispatch_booking_notification: {
        Args: {
          p_booking_id: string
          p_event_type: string
          p_merchant_id: string
        }
        Returns: boolean
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
          hide_notes_from_staff: boolean
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
      cancel_completed_booking: {
        Args: {
          p_booking_id: string
          p_notify_requested?: boolean
          p_reason: string
        }
        Returns: Json
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
      claim_birthday_line_pending: {
        Args: { p_limit?: number }
        Returns: Json[]
      }
      clear_agent_pending_login_email: {
        Args: { p_agent_id: string }
        Returns: undefined
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
      clear_staff_pending_login_email: {
        Args: { p_staff_id: string }
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
          hide_notes_from_staff: boolean
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
      compute_member_loyalty_points: {
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
          hide_notes_from_staff: boolean
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
      consume_line_binding_code: {
        Args: { p_code: string; p_line_user_id: string; p_merchant_id: string }
        Returns: Json
      }
      count_my_recent_test_pushes: {
        Args: { p_merchant_id: string }
        Returns: number
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
          p_hide_notes_from_staff?: boolean
          p_material_cost_items?: Json
          p_member_id?: string
          p_merchant_id: string
          p_notes?: string
          p_payment_method_id?: string
          p_points_override?: number
          p_points_redeem_member_id?: string
          p_points_redeemed?: number
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
          hide_notes_from_staff: boolean
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
      create_member: {
        Args: {
          p_birthday?: string
          p_email?: string
          p_merchant_id: string
          p_name: string
          p_notes?: string
          p_phone?: string
          p_referred_by_member_id?: string
          p_tier_id?: string
        }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
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
      customer_accept_contact_invite: {
        Args: {
          p_agree_policy: boolean
          p_phone: string | null
          p_slug: string
          p_token: string | null
        }
        Returns: Json
      }
      customer_cancel_contact_request: {
        Args: { p_slug: string }
        Returns: Json
      }
      customer_complete_profile: {
        Args: {
          p_agree_policy: boolean
          p_name: string
          p_phone: string
          p_slug: string
        }
        Returns: Json
      }
      customer_create_contact_invite: {
        Args: { p_slug: string }
        Returns: Json
      }
      customer_get_member_home: { Args: { p_slug: string }; Returns: Json }
      customer_get_notify_prefs: { Args: { p_slug: string }; Returns: Json }
      customer_get_profile: { Args: { p_slug: string }; Returns: Json }
      customer_get_wallet: {
        Args: { p_cursor?: string; p_limit?: number; p_slug: string }
        Returns: Json
      }
      customer_leave_member: { Args: { p_slug: string }; Returns: Json }
      customer_list_contacts: { Args: { p_slug: string }; Returns: Json }
      customer_list_my_bookings: {
        Args: {
          p_cursor?: string
          p_limit?: number
          p_scope: string
          p_slug: string
        }
        Returns: Json
      }
      customer_peek_contact_invite: {
        Args: { p_slug: string; p_token: string }
        Returns: Json
      }
      customer_remove_contact: {
        Args: { p_contact_id: string; p_slug: string }
        Returns: Json
      }
      customer_resolve_contact_request: {
        Args: { p_approve: boolean; p_request_id: string; p_slug: string }
        Returns: Json
      }
      customer_revoke_contact_invite: {
        Args: { p_invite_id: string; p_slug: string }
        Returns: Json
      }
      customer_set_my_contact_phone: {
        Args: { p_phone: string; p_slug: string }
        Returns: Json
      }
      customer_set_notify_prefs: {
        Args: {
          p_notify_booking: boolean
          p_notify_promo: boolean
          p_slug: string
        }
        Returns: Json
      }
      customer_transfer_primary: {
        Args: { p_contact_id: string; p_slug: string }
        Returns: Json
      }
      customer_update_profile: {
        Args: {
          p_address: string
          p_birthday: string
          p_email: string
          p_name: string
          p_slug: string
        }
        Returns: Json
      }
      deactivate_member: {
        Args: { p_member_id: string }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      delete_merchant_line_login_config: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      disconnect_merchant_line: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      export_leave_report: {
        Args: {
          p_merchant_id: string
          p_staff_id?: string
          p_start_date_from?: string
          p_start_date_to?: string
        }
        Returns: Json
      }
      export_members_report: { Args: { p_merchant_id: string }; Returns: Json }
      export_orders_report: {
        Args: {
          p_end_at?: string
          p_merchant_id: string
          p_start_at?: string
          p_status?: string
        }
        Returns: Json
      }
      generate_booking_slug: { Args: { p_name: string }; Returns: string }
      generate_member_line_binding_code: {
        Args: { p_member_id: string }
        Returns: {
          code: string
          expires_at: string
        }[]
      }
      generate_own_admin_line_binding_code: {
        Args: { p_merchant_id: string }
        Returns: {
          code: string
          expires_at: string
        }[]
      }
      generate_own_agent_line_binding_code: {
        Args: { p_merchant_id: string }
        Returns: {
          code: string
          expires_at: string
        }[]
      }
      generate_own_staff_line_binding_code: {
        Args: { p_merchant_id: string }
        Returns: {
          code: string
          expires_at: string
        }[]
      }
      generate_staff_line_binding_code: {
        Args: { p_staff_id: string }
        Returns: {
          code: string
          expires_at: string
        }[]
      }
      get_agent_login_email_status: {
        Args: { p_agent_id: string }
        Returns: {
          current_login_email: string
          pending_admin_suggested_email: string
          pending_confirmation_email: string
          pending_confirmation_sent_at: string
        }[]
      }
      get_birthday_bonus_grants: {
        Args: { p_merchant_id: string }
        Returns: {
          anchor_date: string
          bonus_year: number
          granted_at: string
          id: string
          line_attempted_at: string
          line_error: string
          line_status: string
          member_id: string
          member_name: string
          points: number
        }[]
      }
      get_booking_actor_names: {
        Args: { p_merchant_id: string; p_user_ids: string[] }
        Returns: {
          display_name: string
          user_id: string
        }[]
      }
      get_booking_commission_summary: {
        Args: { p_booking_id: string }
        Returns: Json
      }
      get_booking_points_ledger: {
        Args: { p_booking_id: string }
        Returns: Json
      }
      get_booking_status_change_logs: {
        Args: { p_booking_id: string }
        Returns: {
          actor_name_snapshot: string
          actor_role_snapshot: string
          created_at: string
          from_status: string
          id: string
          note: string
          to_status: string
        }[]
      }
      get_completed_booking_reversal_preview: {
        Args: { p_booking_id: string }
        Returns: Json
      }
      get_customer_line_settings: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      get_customer_line_usage: {
        Args: { p_merchant_id: string }
        Returns: Json
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
      get_customer_session_state: { Args: { p_slug: string }; Returns: Json }
      get_line_notification_log: {
        Args: {
          p_category?: string
          p_event_type?: string
          p_limit?: number
          p_merchant_id: string
          p_offset?: number
        }
        Returns: {
          attempted_at: string
          booking_id: string | null
          created_by_user_id: string | null
          error_detail: string | null
          event_type: string
          id: string
          merchant_id: string
          outbox_id: string | null
          rendered_message: string | null
          skip_reason: string | null
          staff_leave_record_id: string | null
          status: string
          target_contact_display_name: string | null
          target_id: string | null
          target_line_user_id: string | null
          target_member_name: string | null
          target_type: string
          target_user_id: string | null
        }[]
      }
      get_material_cost_commission_setting: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      get_member_customer_login_status: {
        Args: { p_member_id: string }
        Returns: Json
      }
      get_member_point_history: {
        Args: { p_member_id: string }
        Returns: {
          balance_after: number
          booking_id: string
          booking_start_at: string
          created_at: string
          created_by_user_id: string
          id: string
          note: string
          points_delta: number
          related_member_id: string
          related_member_name: string
          transaction_type: string
        }[]
      }
      get_member_referrals: {
        Args: { p_member_id: string }
        Returns: {
          created_at: string
          id: string
          name: string
          referral_rewarded_at: string
          status: string
        }[]
      }
      get_member_related_bookings: {
        Args: { p_member_id: string }
        Returns: {
          earned_points: number
          final_amount_snapshot: number
          id: string
          points_planned: number
          points_planned_overridden: boolean
          points_redeemed: number
          reversed_points: number
          service_item_names: string[]
          start_at: string
          status: string
        }[]
      }
      get_members_by_phone: {
        Args: { p_merchant_id: string; p_phone: string }
        Returns: Json
      }
      get_merchant_admin_users: {
        Args: { p_merchant_id: string }
        Returns: {
          created_at: string
          display_name: string
          email: string
          id: string
          job_title: string
          merchant_id: string
          phone: string
          user_id: string
        }[]
      }
      get_merchant_billing_summary: {
        Args: { p_merchant_id: string; p_month: number; p_year: number }
        Returns: Json
      }
      get_merchant_billing_summary_by_range: {
        Args: {
          p_end_date: string
          p_merchant_id: string
          p_start_date: string
        }
        Returns: Json
      }
      get_merchant_bulk_operations: {
        Args: { p_merchant_id: string }
        Returns: {
          column_mapping: Json | null
          created_at: string
          created_by_user_id: string | null
          error_report: Json
          failed_rows: number
          id: string
          merchant_id: string
          operation_type: string
          pre_operation_snapshot: Json
          related_merchant_id: string | null
          rolled_back_at: string | null
          rolled_back_by_user_id: string | null
          skipped_duplicate_rows: number
          status: string
          success_rows: number
          total_rows: number
          write_mode: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "merchant_bulk_operations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_merchant_day_schedule: {
        Args: { p_date: string; p_merchant_id: string }
        Returns: Json
      }
      get_merchant_features: {
        Args: { p_merchant_id: string }
        Returns: {
          description: string
          effective: boolean
          feature_key: string
          granted: boolean | null
          name: string
          off_impact: string
          parent_key: string | null
          preset_enabled: boolean | null
          sort_order: number
        }[]
      }
      get_merchant_line_bot_public_info: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      get_merchant_line_config_status: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      get_merchant_line_login_status: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      get_merchant_points_feature_enabled: {
        Args: { p_merchant_id: string }
        Returns: boolean
      }
      get_merchant_push_event_enabled_map: {
        Args: { p_merchant_id: string }
        Returns: {
          enabled: boolean
          event_type: string
        }[]
      }
      get_my_booking_schedule: {
        Args: { p_end_date: string; p_staff_id: string; p_start_date: string }
        Returns: Json
      }
      get_my_booking_status_colors: {
        Args: { p_staff_id: string }
        Returns: Json
      }
      get_my_calendar_state_styles: {
        Args: { p_staff_id: string }
        Returns: Json
      }
      get_my_day_business_hours: {
        Args: { p_date: string; p_staff_id: string }
        Returns: Json
      }
      get_my_day_schedule_state: {
        Args: { p_date: string; p_staff_id: string }
        Returns: Json
      }
      get_my_staff_availability_windows: {
        Args: { p_staff_id: string }
        Returns: {
          day_of_week: number
          end_time: string
          start_time: string
        }[]
      }
      get_my_push_identity: { Args: { p_merchant_id: string }; Returns: Json }
      get_public_available_slots: {
        Args: {
          p_days: number
          p_from: string
          p_items: Json
          p_slug: string
          p_staff_id: string | null
        }
        Returns: Json
      }
      get_public_booking_page: { Args: { p_slug: string }; Returns: Json }
      get_point_formula_service_items: {
        Args: { p_merchant_id: string }
        Returns: {
          id: string
          name: string
          price: number
          status: string
        }[]
      }
      get_staff_bonus_by_range: {
        Args: { p_end_date: string; p_staff_id: string; p_start_date: string }
        Returns: Json
      }
      get_staff_commission_summary: {
        Args: { p_month: number; p_staff_id: string; p_year: number }
        Returns: Json
      }
      get_staff_commission_summary_by_range: {
        Args: { p_end_date: string; p_staff_id: string; p_start_date: string }
        Returns: Json
      }
      get_staff_login_email_status: {
        Args: { p_staff_id: string }
        Returns: {
          current_login_email: string
          pending_admin_suggested_email: string
          pending_confirmation_email: string
          pending_confirmation_sent_at: string
        }[]
      }
      get_staff_monthly_payroll_summary: {
        Args: { p_month: number; p_staff_id: string; p_year: number }
        Returns: Json
      }
      get_staff_monthly_payroll_summary_by_range: {
        Args: { p_end_date: string; p_staff_id: string; p_start_date: string }
        Returns: Json
      }
      get_staff_push_status: { Args: { p_staff_id: string }; Returns: Json }
      get_staff_schedule_overview: {
        Args: {
          p_end_date: string
          p_merchant_id: string
          p_start_date: string
        }
        Returns: Json
      }
      get_staff_wage_by_range: {
        Args: { p_end_date: string; p_staff_id: string; p_start_date: string }
        Returns: Json
      }
      hard_delete_merchant_agent: {
        Args: { p_agent_id: string }
        Returns: undefined
      }
      hard_delete_merchant_staff: {
        Args: { p_staff_id: string }
        Returns: undefined
      }
      have_my_test_pushes_been_acked: {
        Args: { p_ack_tokens: string[] }
        Returns: boolean
      }
      import_historical_bookings_batch: {
        Args: { p_merchant_id: string; p_rows: Json }
        Returns: string
      }
      import_members_batch: {
        Args: { p_merchant_id: string; p_rows: Json; p_write_mode: string }
        Returns: string
      }
      internal_claim_customer_line_outbox: {
        Args: { p_limit?: number }
        Returns: {
          id: string
          kind: string
          merchant_id: string
        }[]
      }
      internal_customer_cancel_booking: {
        Args: { p_booking_id: string; p_slug: string; p_user_id: string }
        Returns: Json
      }
      internal_customer_contact_invite_claim: {
        Args: { p_merchant_id: string; p_token_hash: string; p_user_id: string }
        Returns: Json
      }
      internal_customer_line_identity_find: {
        Args: { p_channel_id: string; p_sub: string }
        Returns: Json
      }
      internal_customer_line_identity_upsert: {
        Args: {
          p_channel_id: string
          p_display_name: string
          p_picture_url: string
          p_sub: string
          p_user_id: string
        }
        Returns: Json
      }
      internal_customer_line_login_consume: {
        Args: { p_state_hash: string }
        Returns: Json
      }
      internal_customer_line_login_start: {
        Args: {
          p_code_verifier: string
          p_draft: Json
          p_invite_token_hash?: string
          p_ip_hash: string
          p_nonce: string
          p_slug: string
          p_state_hash: string
        }
        Returns: Json
      }
      internal_customer_line_login_succeeded: {
        Args: {
          p_channel_id: string
          p_linked_oa_status: string
          p_merchant_id: string
        }
        Returns: undefined
      }
      internal_customer_submit_booking: {
        Args: {
          p_agree_policy: boolean
          p_draft: Json
          p_guest_phone: string | null
          p_slug: string
          p_submission_id: string
          p_user_id: string | null
        }
        Returns: Json
      }
      internal_finish_customer_line_job: {
        Args: { p_error?: string; p_outbox_id: string; p_outcome: string }
        Returns: Json
      }
      internal_get_line_login_credentials: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      internal_line_marketing_candidates: {
        Args: { p_member_ids: string[]; p_merchant_id: string }
        Returns: Json
      }
      internal_line_quota_check_due: {
        Args: { p_merchant_id: string }
        Returns: boolean
      }
      internal_line_quota_warning: {
        Args: { p_limit: number; p_merchant_id: string; p_used: number }
        Returns: boolean
      }
      internal_merchant_has_feature: {
        Args: { p_feature_key: string; p_merchant_id: string }
        Returns: boolean
      }
      internal_prepare_customer_line_job: {
        Args: { p_outbox_id: string }
        Returns: Json
      }
      internal_rate_limit_hit: {
        Args: {
          p_bucket: string
          p_key: string
          p_max: number
          p_window_seconds: number
        }
        Returns: boolean
      }
      internal_set_line_friendship: {
        Args: {
          p_changed_at: string
          p_is_friend: boolean
          p_line_user_id: string
          p_merchant_id: string
          p_source: string
        }
        Returns: boolean
      }
      invite_merchant_admin: {
        Args: { p_merchant_id: string; p_user_email: string }
        Returns: undefined
      }
      is_staff_push_event_disabled: {
        Args: {
          p_event_type: string
          p_merchant_id: string
          p_staff_id: string
        }
        Returns: boolean
      }
      list_line_marketable_members: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      list_member_contacts: { Args: { p_member_id: string }; Returns: Json }
      list_report_export_staff: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      list_staff_bonus_plans: { Args: { p_merchant_id: string }; Returns: Json }
      list_staff_bookable_start_times: {
        Args: {
          p_date: string
          p_duration_minutes: number
          p_exclude_booking_id?: string
          p_merchant_id: string
          p_staff_id: string
        }
        Returns: string[]
      }
      list_staff_wages: { Args: { p_merchant_id: string }; Returns: Json }
      lookup_user_id_by_email: { Args: { p_email: string }; Returns: string }
      mark_agent_active_if_self: { Args: never; Returns: undefined }
      mark_birthday_line_result: {
        Args: {
          p_error?: string
          p_grant_id: string
          p_log_id?: string
          p_status: string
        }
        Returns: boolean
      }
      mark_my_notifications_read: {
        Args: { p_ids?: string[] }
        Returns: number
      }
      mark_staff_login_active_if_self: { Args: never; Returns: undefined }
      merchant_remove_member_contact: {
        Args: { p_contact_id: string; p_new_primary_contact_id?: string }
        Returns: Json
      }
      merchant_resolve_contact_request: {
        Args: { p_approve: boolean; p_request_id: string }
        Returns: Json
      }
      merchant_set_primary_contact: {
        Args: { p_contact_id: string }
        Returns: Json
      }
      move_booking: {
        Args: {
          p_booking_id: string
          p_dragged_staff_id: string
          p_expected_staff_id: string
          p_expected_start_at: string
          p_target_staff_id: string
          p_target_start_at: string
        }
        Returns: Json
      }
      move_merchant_staff_order: {
        Args: { p_direction: string; p_staff_id: string }
        Returns: Json
      }
      platform_add_merchant_admin: {
        Args: { p_merchant_id: string; p_user_email: string }
        Returns: undefined
      }
      platform_export_merchant_members_snapshot: {
        Args: { p_merchant_id: string }
        Returns: Json
      }
      platform_feature_usage_summary: {
        Args: never
        Returns: {
          disabled_count: number
          enabled_count: number
          feature_key: string
        }[]
      }
      platform_get_merchant_admin_counts: {
        Args: never
        Returns: {
          admin_count: number
          merchant_id: string
        }[]
      }
      platform_get_merchant_agents: {
        Args: { p_merchant_id: string }
        Returns: {
          created_at: string
          id: string
          job_title: string
          login_email: string
          merchant_id: string
          name: string
          nickname: string
          phone: string
          status: string
          user_id: string
        }[]
      }
      platform_get_merchant_staff: {
        Args: { p_merchant_id: string }
        Returns: {
          compensation_type: string
          created_at: string
          id: string
          login_email: string
          login_status: string
          merchant_id: string
          name: string
          nickname: string
          phone: string
          status: string
          user_id: string
        }[]
      }
      platform_get_user_email: { Args: { p_user_id: string }; Returns: string }
      platform_list_merchant_bulk_operations: {
        Args: { p_merchant_id: string }
        Returns: {
          column_mapping: Json | null
          created_at: string
          created_by_user_id: string | null
          error_report: Json
          failed_rows: number
          id: string
          merchant_id: string
          operation_type: string
          pre_operation_snapshot: Json
          related_merchant_id: string | null
          rolled_back_at: string | null
          rolled_back_by_user_id: string | null
          skipped_duplicate_rows: number
          status: string
          success_rows: number
          total_rows: number
          write_mode: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "merchant_bulk_operations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      platform_list_merchant_feature_logs: {
        Args: { p_limit?: number; p_merchant_id: string }
        Returns: {
          changed_by_email: string | null
          created_at: string
          feature_key: string
          feature_name: string
          is_bulk: boolean
          new_enabled: boolean
          note: string | null
          old_enabled: boolean | null
        }[]
      }
      platform_purge_merchant_members_and_points: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      platform_remove_merchant_admin: {
        Args: { p_merchant_id: string; p_user_id: string }
        Returns: undefined
      }
      platform_save_feature_settings: {
        Args: { p_bulk?: Json; p_note?: string | null; p_presets?: Json }
        Returns: Json
      }
      platform_set_feature_for_all_merchants: {
        Args: {
          p_also_presets?: boolean
          p_enabled: boolean
          p_feature_key: string
          p_note?: string | null
        }
        Returns: number
      }
      platform_set_group_admin: {
        Args: { p_group_id: string; p_user_email: string }
        Returns: undefined
      }
      platform_set_merchant_features: {
        Args: { p_changes: Json; p_merchant_id: string; p_note?: string | null }
        Returns: number
      }
      platform_set_merchant_feature: {
        Args: {
          p_enabled: boolean
          p_feature_key: string
          p_merchant_id: string
          p_note?: string | null
        }
        Returns: undefined
      }
      preview_bonus_formula: {
        Args: {
          p_merchant_id: string
          p_month?: string
          p_sample?: Json
          p_staff_id?: string
          p_text: string
        }
        Returns: Json
      }
      preview_booking_points: {
        Args: {
          p_booking_id: string
          p_custom_total_amount: number
          p_custom_total_amount_enabled: boolean
          p_customer_phone: string
          p_discount_enabled: boolean
          p_discount_mode: string
          p_discount_value: number
          p_member_id: string
          p_merchant_id: string
          p_service_items: Json
          p_tax_enabled: boolean
          p_tax_mode: string
          p_tax_value: number
        }
        Returns: Json
      }
      preview_line_marketing_recipients: {
        Args: { p_member_ids: string[]; p_merchant_id: string }
        Returns: Json
      }
      preview_line_notification_targets: {
        Args: { p_booking_id: string; p_event_type: string }
        Returns: Json
      }
      preview_staff_bonus: {
        Args: {
          p_merchant_id: string
          p_month: string
          p_rules: Json
          p_staff_id: string
        }
        Returns: Json
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
      prune_user_notifications: { Args: never; Returns: number }
      reactivate_member: {
        Args: { p_member_id: string }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      recalculate_booking_commission: {
        Args: { p_booking_id: string }
        Returns: {
          booking_id: string
          commission_amount: number
          commission_base_amount_snapshot: number
          commission_basis_type_snapshot: string
          commission_rate_percentage_snapshot: number | null
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
      recompute_staff_work_day: {
        Args: { p_date: string; p_staff_id: string }
        Returns: Json
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
      record_invited_staff_login: {
        Args: {
          p_invited_login_email: string
          p_login_status: string
          p_staff_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      redeem_member_points: {
        Args: { p_member_id: string; p_note: string; p_points: number }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_booking_assistant: {
        Args: { p_booking_id: string; p_staff_id: string }
        Returns: Json
      }
      remove_merchant_admin: {
        Args: { p_merchant_id: string; p_user_id: string }
        Returns: undefined
      }
      remove_merchant_agent: {
        Args: { p_agent_id: string }
        Returns: undefined
      }
      render_booking_notification_variables: {
        Args: { p_booking_id: string; p_merchant_id: string }
        Returns: Json
      }
      render_staff_leave_notification_variables: {
        Args: { p_merchant_id: string; p_staff_leave_record_id: string }
        Returns: Json
      }
      request_agent_login_email_change: {
        Args: { p_agent_id: string; p_new_email: string }
        Returns: undefined
      }
      request_staff_login_email_change: {
        Args: { p_new_email: string; p_staff_id: string }
        Returns: undefined
      }
      resolve_line_notification_targets: {
        Args: {
          p_booking_id?: string
          p_event_type: string
          p_merchant_id: string
          p_staff_leave_record_id?: string
        }
        Returns: Json
      }
      resolve_push_recipients: {
        Args: {
          p_booking_staff_id: string
          p_event_type: string
          p_merchant_id: string
        }
        Returns: {
          target_id: string
          target_name: string
          target_type: string
          target_user_id: string
        }[]
      }
      restore_merchant_agent: {
        Args: { p_agent_id: string }
        Returns: {
          activated_at: string | null
          created_at: string
          id: string
          invited_at: string
          invited_email: string
          job_title: string | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          nickname: string | null
          pending_admin_login_email: string | null
          pending_admin_login_email_requested_at: string | null
          pending_admin_login_email_requested_by: string | null
          phone: string
          status: string
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "merchant_agents"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revert_completed_booking: {
        Args: { p_booking_id: string; p_reason: string }
        Returns: Json
      }
      rollback_bulk_operation: {
        Args: { p_operation_id: string }
        Returns: Json
      }
      run_birthday_bonus_grants: {
        Args: { p_run_date?: string }
        Returns: number
      }
      save_staff_bonus_plan: {
        Args: {
          p_effective?: string
          p_merchant_id: string
          p_name: string
          p_plan_id: string
          p_rules: Json
        }
        Returns: string
      }
      search_members_by_contact_phone: {
        Args: { p_merchant_id: string; p_term: string }
        Returns: Json
      }
      seed_default_booking_status_colors: {
        Args: { p_merchant_id: string }
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
      seed_default_line_event_settings: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      seed_default_member_settings: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      seed_default_merchant_calendar_state_styles: {
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
      seed_default_push_event_settings: {
        Args: { p_merchant_id: string }
        Returns: undefined
      }
      seed_default_staff_permissions: {
        Args: { p_staff_id: string }
        Returns: undefined
      }
      set_agent_permission: {
        Args: { p_agent_id: string; p_granted: boolean; p_section_key: string }
        Returns: undefined
      }
      set_agent_permissions: {
        Args: { p_agent_id: string; p_changes: Json }
        Returns: undefined
      }
      set_material_cost_affects_commission: {
        Args: { p_enabled: boolean; p_merchant_id: string }
        Returns: Json
      }
      set_member_blacklist_status: {
        Args: {
          p_is_blacklisted: boolean
          p_member_id: string
          p_reason?: string
        }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_merchant_line_credentials: {
        Args: {
          p_channel_access_token: string
          p_channel_id: string
          p_channel_secret: string
          p_merchant_id: string
        }
        Returns: undefined
      }
      set_customer_line_monthly_cap: {
        Args: { p_merchant_id: string; p_monthly_cap: number | null }
        Returns: Json
      }
      set_merchant_line_login_config: {
        Args: {
          p_channel_id: string
          p_channel_secret: string
          p_merchant_id: string
        }
        Returns: undefined
      }
      set_merchant_line_login_enabled: {
        Args: { p_enabled: boolean; p_merchant_id: string }
        Returns: undefined
      }
      set_staff_bonus_plan: {
        Args: { p_plan_id: string; p_staff_id: string }
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
      set_staff_permission: {
        Args: { p_granted: boolean; p_section_key: string; p_staff_id: string }
        Returns: undefined
      }
      set_staff_wage: {
        Args: { p_amount: number; p_staff_id: string }
        Returns: Json
      }
      staff_cancel_booking: {
        Args: { p_booking_id: string; p_reason?: string }
        Returns: Json
      }
      staff_complete_booking: { Args: { p_booking_id: string }; Returns: Json }
      staff_create_booking: {
        Args: {
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
          p_material_cost_items?: Json
          p_notes?: string
          p_payment_method_id?: string
          p_points_override?: number
          p_points_redeem_member_id?: string
          p_points_redeemed?: number
          p_service_items: Json
          p_staff_id: string
          p_start_at: string
          p_tax_enabled?: boolean
          p_tax_mode?: string
          p_tax_value?: number
        }
        Returns: Json
      }
      staff_get_booking_for_edit: {
        Args: { p_booking_id: string }
        Returns: Json
      }
      staff_get_booking_form_options: {
        Args: { p_staff_id: string }
        Returns: Json
      }
      staff_list_my_bookable_start_times: {
        Args: {
          p_date: string
          p_duration_minutes: number
          p_exclude_booking_id?: string
          p_staff_id: string
        }
        Returns: string[]
      }
      staff_move_booking: {
        Args: {
          p_booking_id: string
          p_expected_start_at: string
          p_target_start_at: string
        }
        Returns: Json
      }
      staff_preview_booking_points: {
        Args: {
          p_booking_id: string
          p_custom_total_amount: number
          p_custom_total_amount_enabled: boolean
          p_customer_phone: string
          p_discount_enabled: boolean
          p_discount_mode: string
          p_discount_value: number
          p_service_items: Json
          p_staff_id: string
          p_tax_enabled: boolean
          p_tax_mode: string
          p_tax_value: number
        }
        Returns: Json
      }
      staff_set_my_slot: {
        Args: {
          p_date: string
          p_end_time: string
          p_is_available: boolean
          p_staff_id: string
          p_start_time: string
        }
        Returns: number
      }
      staff_update_booking: {
        Args: {
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
          p_material_cost_items?: Json
          p_notes?: string
          p_payment_method_id?: string
          p_points_override?: number
          p_points_override_reset?: boolean
          p_points_redeem_member_id?: string
          p_points_redeemed?: number
          p_service_items: Json
          p_start_at: string
          p_tax_enabled?: boolean
          p_tax_mode?: string
          p_tax_value?: number
        }
        Returns: Json
      }
      storage_path_merchant_id: { Args: { p_path: string }; Returns: string }
      staff_confirm_booking: {
        Args: { p_booking_id: string }
        Returns: Json
      }
      storage_path_self_staff_id: {
        Args: { p_object_name: string }
        Returns: string
      }
      transfer_members_to_merchant: {
        Args: {
          p_member_ids: string[]
          p_source_merchant_id: string
          p_target_merchant_id: string
        }
        Returns: string
      }
      unbind_line_account: {
        Args: { p_target_id: string; p_target_type: string }
        Returns: undefined
      }
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
          p_hide_notes_from_staff?: boolean
          p_material_cost_items?: Json
          p_member_id?: string
          p_notes?: string
          p_payment_method_id?: string
          p_points_override?: number
          p_points_override_reset?: boolean
          p_points_redeem_member_id?: string
          p_points_redeemed?: number
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
          hide_notes_from_staff: boolean
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
          hide_notes_from_staff: boolean
          id: string
          last_modified_at: string | null
          last_modified_by_user_id: string | null
          member_auto_created: boolean
          member_id: string | null
          member_name_snapshot: string | null
          merchant_id: string
          notes: string | null
          payment_method_id: string | null
          payment_method_name_snapshot: string | null
          points_planned: number
          points_planned_auto: number
          points_planned_breakdown: Json
          points_planned_overridden: boolean
          points_redeem_amount_snapshot: number
          points_redeemed: number
          points_review_required: boolean
          service_description_snapshot: string | null
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
      update_customer_line_settings: {
        Args: { p_merchant_id: string; p_patch: Json }
        Returns: Json
      }
      update_line_event_setting: {
        Args: {
          p_enabled: boolean
          p_event_type: string
          p_merchant_id: string
          p_message_template: string
          p_notify_admin: boolean
          p_notify_agent: boolean
          p_notify_member: boolean
          p_notify_staff: boolean
        }
        Returns: {
          created_at: string
          enabled: boolean
          event_type: string
          id: string
          merchant_id: string
          message_template: string
          notify_admin: boolean
          notify_agent: boolean
          notify_member: boolean
          notify_staff: boolean
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "merchant_line_event_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_member: {
        Args: {
          p_address?: string
          p_birthday: string
          p_email: string
          p_member_id: string
          p_name: string
          p_notes: string
          p_phone: string
          p_tier_id?: string
        }
        Returns: {
          address: string | null
          birthday: string | null
          blacklist_reason: string | null
          blacklisted_at: string | null
          blacklisted_by_user_id: string | null
          created_at: string
          created_by_user_id: string | null
          email: string | null
          id: string
          identity_first_verified_at: string | null
          identity_verified_at: string | null
          identity_verified_via: string | null
          is_blacklisted: boolean
          last_birthday_bonus_year: number | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          notes: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          points_balance: number
          referral_code: string
          referral_rewarded_at: string | null
          referred_by_member_id: string | null
          status: string
          tier_id: string | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_merchant_agent: {
        Args: {
          p_agent_id: string
          p_job_title: string
          p_name: string
          p_nickname: string
          p_phone: string
        }
        Returns: {
          activated_at: string | null
          created_at: string
          id: string
          invited_at: string
          invited_email: string
          job_title: string | null
          line_bound: boolean
          line_user_id: string | null
          merchant_id: string
          name: string
          nickname: string | null
          pending_admin_login_email: string | null
          pending_admin_login_email_requested_at: string | null
          pending_admin_login_email_requested_by: string | null
          phone: string
          status: string
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "merchant_agents"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_merchant_booking_status_colors: {
        Args: {
          p_accepted_color: string
          p_cancelled_color: string
          p_completed_color: string
          p_merchant_id: string
          p_pending_confirmation_color: string
        }
        Returns: {
          accepted_color: string
          cancelled_color: string
          completed_color: string
          created_at: string
          merchant_id: string
          pending_confirmation_color: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "merchant_booking_status_colors"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_merchant_calendar_state_styles: {
        Args: {
          p_cross_store_occupied_color: string
          p_cross_store_occupied_opacity?: number
          p_full_day_leave_color: string
          p_full_day_leave_opacity?: number
          p_merchant_id: string
          p_outside_business_hours_color?: string
          p_outside_business_hours_opacity?: number
          p_partial_leave_color: string
          p_partial_leave_opacity?: number
          p_staff_available_slot_color?: string
          p_staff_available_slot_opacity?: number
        }
        Returns: {
          color: string
          created_at: string
          merchant_id: string
          opacity: number
          state_type: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "merchant_calendar_state_styles"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      update_my_admin_profile: {
        Args: {
          p_display_name: string
          p_job_title: string
          p_merchant_id: string
          p_phone: string
        }
        Returns: undefined
      }
      update_my_staff_profile: {
        Args: {
          p_avatar_url: string
          p_intro: string
          p_name: string
          p_nickname: string
          p_phone: string
          p_staff_id: string
        }
        Returns: undefined
      }
      update_push_event_setting: {
        Args: {
          p_enabled: boolean
          p_event_type: string
          p_merchant_id: string
          p_message_body: string
          p_message_title: string
        }
        Returns: {
          created_at: string
          enabled: boolean
          event_type: string
          id: string
          merchant_id: string
          message_body: string
          message_title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "merchant_push_event_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_member_point_formulas: {
        Args: { p_formulas: Json; p_merchant_id: string }
        Returns: {
          created_at: string
          enabled: boolean
          id: string
          merchant_id: string
          min_unit_price: number
          name: string
          points_per_unit: number
          service_item_id: string | null
          sort_order: number
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "merchant_point_formulas"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      upsert_my_push_subscription: {
        Args: {
          p_auth_key: string
          p_endpoint: string
          p_p256dh_key: string
          p_user_agent?: string
        }
        Returns: {
          auth_key: string
          created_at: string
          endpoint: string
          id: string
          last_seen_at: string | null
          p256dh_key: string
          user_agent: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "push_subscriptions"
          isOneToOne: true
          isSetofReturn: false
        }
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

