/**
 * Common domain string-union types shared across apps and packages.
 * (Phase 1 domain tables will reference these values.)
 */

/** Who can see a record inside a household. */
export type Visibility = 'private' | 'household' | 'summary_only';

/** How sensitively a record must be handled (logging/AI exposure rules). */
export type Sensitivity = 'normal' | 'private' | 'confidential';

/** Which workspace a record belongs to. */
export type WorkspaceKind = 'personal' | 'company';
