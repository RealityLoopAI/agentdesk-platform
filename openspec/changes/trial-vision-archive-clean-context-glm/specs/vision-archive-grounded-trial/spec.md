## ADDED Requirements

### Requirement: Vision Archive Skill is schema-neutral
The Vision Archive Worker's private Skill MUST NOT contain example result field names or example field values that could be repeated as though they were read from an archive.

#### Scenario: Skill guidance is loaded
- **WHEN** the Archive Worker loads its private Skill
- **THEN** the guidance describes a discovery and read procedure without asserting any archive-specific result fields or values

### Requirement: Archive answer uses current-request evidence
The Vision Archive Worker MUST make file names, sizes, timestamps, report contents, and structured field claims only from successful gateway tool results produced for the current user request.

#### Scenario: Search and read succeed
- **WHEN** current-request gateway calls successfully return archive metadata or structured content
- **THEN** the Worker may report only values present in those returned results

#### Scenario: Required read does not succeed
- **WHEN** a requested file or structured object is not returned by a successful current-request tool call
- **THEN** the Worker states that it could not verify the requested information
- **AND** it does not substitute prior conversation claims or Skill examples

### Requirement: GLM trial starts with fresh Worker context
The system SHALL retire the existing Archive Worker session before the GLM-backed verification request without directly modifying the session's container-owned outbound database.

#### Scenario: Existing Worker session is active
- **WHEN** the operator begins the GLM trial
- **THEN** the Worker container is stopped
- **AND** the supported archive operation preserves the old session as an archive
- **AND** the next root-session delegation creates a different active Worker session

### Requirement: Trial response is checked against gateway evidence
The GLM-backed natural-language trial SHALL compare the final Worker response with the gateway calls and NAS-backed results from the same request.

#### Scenario: Final response contains file facts
- **WHEN** the trial response names a report or states its metadata
- **THEN** each claimed fact is present in a successful gateway result from that request
- **AND** any mismatch is reported as a failed trial rather than accepted as a successful query
