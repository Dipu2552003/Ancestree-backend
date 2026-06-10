// Shared types for the merge module. Internal row shapes (e.g. the search
// candidate row) live next to the query that produces them.

export interface SentMergeRequest {
  id:                    string
  status:                'proposed' | 'confirmed' | 'rejected' | 'reversed'
  canonical_person_name: string
  canonical_family_name: string
  merged_person_name:    string
  created_at:            string
  merged_at:             string | null
}

export interface SearchInput {
  fullName:       string
  firstName?:     string | null
  lastName?:      string | null
  birthYear?:     number | null
  nativeVillage?: string | null
  gotra?:         string | null
  gender?:        string | null
}

export interface PotentialMatch {
  id:             string
  full_name:      string
  birth_year:     number | null
  native_village: string | null
  current_city:   string | null
  gotra:          string | null
  gender:         string | null
  photo_url:      string | null
  father_name:    string | null
  family_name:    string
  family_id:      string
  member_count:   number
  match_score:    number
  matched_fields: string[]
}

export interface MergeDetails {
  id:                    string
  status:                'proposed' | 'confirmed' | 'rejected' | 'reversed'
  canonical_person_id:   string
  canonical_person_name: string
  canonical_family_id:   string
  canonical_family_name: string
  merged_person_id:      string
  merged_person_name:    string
  merged_family_id:      string
  merged_family_name:    string
  created_at:            string
}
