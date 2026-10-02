// Natural-language phrasing people type rarely matches the dataset's own
// short internal vocabulary (code / cue_type / failure_mode tags, e.g.
// "none_vague", "degraded_after_update"). BM25 is purely lexical, so a
// question like "how do users search when their memory is incomplete"
// shares almost no words with either the raw quotes or those tags, and
// search quietly returns nothing relevant even though the underlying
// theme is well covered (89 of 365 episodes are tagged cue_type
// "none_vague" alone).
//
// This table is grounded in the real codebook (codebook.md) and the real
// cue_type / failure_mode vocabulary pulled directly from data.json --
// not guessed synonyms. Each group's `expand` tokens are words that
// literally appear in the `code` / `cue` / `fm` fields of the matching
// episodes, so adding them to a query's term set lets BM25 find those
// episodes even when the user's own words never appear in the evidence
// text itself.

type ConceptGroup = { trigger: string[]; expand: string[] };

export const CONCEPT_GROUPS: ConceptGroup[] = [
  // cue_type "none_vague" (89 episodes) + code "cant_find_photos_vague" (21)
  // -- thin/vague complaints with no specific search mechanism given. This
  // is the group that was missing a question like "how do users search
  // when their memory is incomplete?".
  {
    trigger: [
      "memory", "remember", "remembering", "recall", "recalling", "recollect",
      "forgot", "forgotten", "forget", "vague", "unsure", "uncertain",
      "approximate", "roughly", "blurry", "fuzzy", "incomplete", "formulate",
      "formulating", "phrasing", "wording", "describe", "description",
    ],
    expand: ["vague", "none", "cant", "find"],
  },
  // code "search_degraded_after_update" (25) + fm "degraded_after_update" (71)
  {
    trigger: ["worse", "broke", "broken", "regress", "regressed", "regression", "degraded", "declined", "downgrade", "downgraded", "stopped"],
    expand: ["degraded", "update", "worse"],
  },
  // code "search_keyword_no_results" (32) + fm "no_results" (61)
  {
    trigger: ["nothing", "zero", "empty", "blank"],
    expand: ["no", "results", "keyword"],
  },
  // code "photos_vanished_unexplained" (35) + fm "data_lost_or_deleted" (60)
  {
    trigger: ["missing", "lost", "deleted", "vanished", "disappeared", "gone", "erased"],
    expand: ["vanished", "unexplained", "lost", "deleted"],
  },
  // code "search_ui_confusing" (43) + fm "ui_navigation_hard" (29)
  {
    trigger: ["confusing", "navigation", "layout", "interface", "ui"],
    expand: ["ui", "confusing", "navigation"],
  },
  // code "face_person_search_issue" (17) + cue "person_face" (32)
  {
    trigger: ["face", "faces", "facial", "people"],
    expand: ["person", "face"],
  },
  // code "album_access_broken" (21) + "album_search_missing" (10) + cue "album_name" (44)
  {
    trigger: ["album", "albums", "folder", "folders", "collection"],
    expand: ["album"],
  },
  // code "date_search_unreliable" (10) + "date_browse_structure_removed" (12) + cue "date_time" (43)
  {
    trigger: ["date", "dates", "timeline", "chronological", "month", "year"],
    expand: ["date", "time"],
  },
  // code "location_search_fails" (5) + cue "location_place" (8)
  {
    trigger: ["location", "place", "map", "gps"],
    expand: ["location", "place"],
  },
  // code "download_export_fails" (12) + fm "download_export_failed" (12)
  {
    trigger: ["download", "export", "save"],
    expand: ["download", "export"],
  },
  // code "platform_inconsistency_missing_photos" (9) + fm "inconsistent_across_platform" (12)
  {
    trigger: ["platform", "device", "web", "mobile", "desktop", "laptop"],
    expand: ["platform", "inconsistent"],
  },
  // code "ocr_text_in_image_search_fails" (5) + cue "visual_text_in_image" (6)
  {
    trigger: ["text", "screenshot", "ocr", "sign"],
    expand: ["text", "ocr", "image"],
  },
  // code "sensitive_content_search_blocked" (5) + fm "sensitive_content_blocked" (5)
  {
    trigger: ["sensitive", "blocked", "nsfw", "explicit", "flagged"],
    expand: ["sensitive", "blocked"],
  },
  // code "object_label_search_wrong" (9) + cue "keyword_object" (83)
  {
    trigger: ["object", "label", "tag", "category"],
    expand: ["object", "keyword"],
  },
  // code "lost_after_account_or_device_change" (11)
  {
    trigger: ["account", "reinstall", "reinstalled", "migrated", "switched"],
    expand: ["account", "device", "change"],
  },
  // code "search_doesnt_find_recent" (6) + cue "recency" (11)
  {
    trigger: ["recent", "recently", "newly"],
    expand: ["recent"],
  },
  // code "search_positive_experience" (36) + fm "positive_no_failure" (37)
  {
    trigger: ["easy", "easily", "success", "positive"],
    expand: ["positive"],
  },
  // code "video_search_fails" (7) + cue "file_type_video" (15)
  {
    trigger: ["video", "videos", "clip", "clips"],
    expand: ["video"],
  },
  // code "duplicate_clutter_hinders_search" (2) + "screenshot_clutter_hinders_browse" (4)
  {
    trigger: ["duplicate", "duplicates", "clutter"],
    expand: ["duplicate", "clutter", "screenshot"],
  },
  // code "cant_filter_by_media_type" (4)
  {
    trigger: ["filter", "filtering"],
    expand: ["filter"],
  },
  // code "filename_search_unreliable" (3)
  {
    trigger: ["filename", "filenames"],
    expand: ["filename"],
  },
  // code "sort_option_missing" (2)
  {
    trigger: ["sort", "sorting"],
    expand: ["sort"],
  },
  // code "search_limited_to_synced_folders" (2) + "third_party_media_not_synced" (2)
  {
    trigger: ["synced", "sync", "syncing", "whatsapp", "samsung"],
    expand: ["synced", "sync"],
  },
  // code "similar_photo_search_missing" (1)
  {
    trigger: ["similar"],
    expand: ["similar"],
  },
  // code "caption_description_search_fails" (5)
  {
    trigger: ["caption", "captions"],
    expand: ["caption"],
  },
  // code "search_result_irrelevant" (2) + fm "wrong_irrelevant_results" (11)
  {
    trigger: ["irrelevant", "inaccurate", "wrong"],
    expand: ["irrelevant", "wrong"],
  },
];

// Returns a weighted map of search terms: the original query terms at full
// weight (1), plus any concept-group tokens whose triggers appeared in the
// query, at a lower weight (0.6). Lower weight means a literal word match
// still outranks a synonym-only one -- this widens the net without letting
// it swamp more specific, directly-worded questions.
export function expandQueryTerms(terms: string[]): Map<string, number> {
  const weighted = new Map<string, number>();
  for (const t of terms) weighted.set(t, 1);

  const termSet = new Set(terms);
  for (const group of CONCEPT_GROUPS) {
    if (group.trigger.some((trig) => termSet.has(trig))) {
      for (const extra of group.expand) {
        if (!weighted.has(extra)) weighted.set(extra, 0.6);
      }
    }
  }
  return weighted;
}
