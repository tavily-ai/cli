# Python test ledger

Every test function in the Python suite (tavily-cli 0.2.1), with the vitest test that replaces it or the reason it was dropped. Vitest names are written `file > describe > test`. The allowed drop reasons are "Python-only mechanism" and "superseded by a contract case" (`tests/contract.test.ts`, cases in `tests/fixtures/contract/cases.json`). Rows marked GAP have no replacement and no allowed drop reason.

## tests/test_cli.py

- `test_cli_help_promotes_guided_setup_and_browser_login`: `tests/cli.test.ts > --help lists every command and the setup hint`
- `test_repl_help_lists_init_and_update`: `tests/repl.test.ts > help lists init and update; banner promotes init and login`
- `test_repl_banner_promotes_init_and_browser_login`: `tests/repl.test.ts > help lists init and update; banner promotes init and login`

## tests/test_defaults.py

- `test_set_default_creates_both_files`: `tests/defaults.test.ts > set-default creates both files`
- `test_claude_round_trip_preserves_existing_settings`: `tests/defaults.test.ts > claude round trip preserves existing settings`
- `test_claude_unset_drops_empty_permissions`: `tests/defaults.test.ts > claude unset drops empty permissions`
- `test_claude_invalid_json_is_not_overwritten`: `tests/defaults.test.ts > claude invalid json is not overwritten`
- `test_codex_round_trip_keeps_tables`: `tests/defaults.test.ts > codex round trip keeps tables`
- `test_codex_set_replaces_existing_top_level_value`: `tests/defaults.test.ts > codex set replaces existing top-level value`
- `test_prompts_when_no_flags`: `tests/defaults.test.ts > prompts per agent when no flags are given`
- `test_no_flags_non_interactive_is_usage_error`: `tests/defaults.test.ts > no flags in a non-interactive run is a usage error`
- `test_project_scope_writes_to_cwd`: `tests/defaults.test.ts > project scope writes to cwd`

## tests/test_init.py

- `test_detect_agents_only_returns_existing_markers`: `tests/skills.test.ts > detectAgents > only returns existing markers`
- `test_detect_agents_honors_custom_agent_directories`: `tests/skills.test.ts > detectAgents > honors custom agent directories`
- `test_agent_skills_install_runs_npx`: `tests/skills.test.ts > installAgentSkills > runs npx`
- `test_agent_skills_install_counts_new_agent_links`: `tests/skills.test.ts > installAgentSkills > counts new agent links`
- `test_agent_skills_install_requires_npx`: `tests/skills.test.ts > installAgentSkills > requires npx`
- `test_agent_skills_install_reports_npx_failure`: `tests/skills.test.ts > installAgentSkills > reports npx failure`
- `test_init_skips_skills_without_detected_agents`: `tests/init.test.ts > init > skips skills without detected agents`
- `test_init_json_reuses_environment_auth`: `tests/init.test.ts > init > --json reuses environment auth`
- `test_init_noninteractive_auth_failure_is_json`: `tests/init.test.ts > init > non-interactive auth failure is JSON`
- `test_init_live_search_failure_exits_four`: `tests/init.test.ts > init > live search failure exits four`

## tests/test_install_sh.py

- `test_fresh_interactive_install_hands_off_to_init`: `tests/install-sh.test.ts > test_fresh_interactive_install_hands_off_to_init`
- `test_noninteractive_install_prints_init_without_running_it`: `tests/install-sh.test.ts > test_noninteractive_install_prints_init_without_running_it`
- `test_init_failure_does_not_fail_successful_install`: `tests/install-sh.test.ts > test_init_failure_does_not_fail_successful_install`
- `test_existing_uv_install_upgrades_without_rerunning_init`: `tests/install-sh.test.ts > install.sh > with a terminal > an upgrade of an existing install does not run init` (pty run; checks the upgrade command and that init never runs), plus `tests/install-sh.test.ts > install.sh > existing npm install upgrades with npm install -g @tavily/cli@latest`.
- `test_failed_fresh_uv_install_exits_without_running_init`: `tests/install-sh.test.ts > install.sh > a failed fresh install exits non-zero and never runs init`.
- `test_automation_and_remote_sessions_do_not_run_init`: `tests/install-sh.test.ts > test_automation_and_remote_sessions_do_not_run_init (%s)`
- `test_pip_path_upgrades_the_package`: dropped, Python-only mechanism (pip install path in install.sh).
- `test_pip_user_install_warns_with_user_base_bin`: dropped, Python-only mechanism (pip `--user` and the Python user base bin directory).
- `test_existing_pipx_install_wins_over_available_uv`: dropped, Python-only mechanism (pipx vs. uv). The npm-side analogue is `tests/install-sh.test.ts > existing pnpm install wins over available npm`.
- `test_existing_pip_install_wins_over_available_uv`: dropped, Python-only mechanism (pip vs. uv). The npm-side analogue is `tests/install-sh.test.ts > existing pnpm install wins over available npm`.

## tests/test_oauth.py

- `test_pkce_is_s256_and_unpadded`: `tests/oauth.test.ts > pkce is S256 and unpadded`
- `test_token_expiry_skew`: `tests/oauth.test.ts > token expiry skew`
- `test_malformed_token_expiry_is_expired`: `tests/oauth.test.ts > malformed token expiry %j is expired`
- `test_authorize_url_includes_pkce_and_resource`: `tests/oauth.test.ts > authorize url includes pkce and resource`
- `test_register_client_public_pkce`: `tests/oauth.test.ts > registerClient > public pkce`
- `test_register_client_rejects_http_errors`: `tests/oauth.test.ts > registerClient > rejects http errors`
- `test_register_client_normalizes_malformed_success_responses`: `tests/oauth.test.ts > registerClient > normalizes malformed success response %s`
- `test_register_client_rejects_invalid_confidential_client_secret`: `tests/oauth.test.ts > registerClient > rejects invalid confidential client secret`
- `test_fetch_metadata_uses_discovery`: `tests/oauth.test.ts > fetchMetadata > uses discovery`
- `test_fetch_metadata_rejects_untrusted_authorization_metadata`: `tests/oauth.test.ts > fetchMetadata > rejects untrusted authorization metadata %s`
- `test_fetch_metadata_rejects_different_protected_resource`: `tests/oauth.test.ts > fetchMetadata > rejects different protected resource`
- `test_refresh_tokens_keeps_refresh_if_omitted`: `tests/oauth.test.ts > tokens > refresh keeps refresh token if omitted`
- `test_token_request_normalizes_malformed_success_responses`: `tests/oauth.test.ts > tokens > normalizes malformed success response %s`
- `test_revoke_public_client_uses_standard_request_first`: `tests/oauth.test.ts > revokeToken > public client uses standard request first`
- `test_revoke_public_client_retries_known_400_with_empty_secret`: `tests/oauth.test.ts > revokeToken > public client retries known 400 with empty secret`
- `test_revoke_token_raises_after_failed_compatibility_retry`: `tests/oauth.test.ts > revokeToken > raises after failed compatibility retry`
- `test_stored_oauth_revokes_refresh_before_access`: `tests/config.test.ts > stored oauth revokes refresh before access`
- `test_clear_credentials_reports_revocation_failure_but_clears_disk`: `tests/config.test.ts > clear credentials reports revocation failure but clears disk`
- `test_logout_json_reports_partial_revocation_failure`: `tests/auth.test.ts > logout > --json reports partial revocation failure and exits 3`
- `test_logout_json_reports_remaining_environment_credential`: `tests/auth.test.ts > logout > --json reports a remaining environment credential`
- `test_logout_json_reports_unauthenticated_after_cleanup`: `tests/auth.test.ts > logout > --json reports unauthenticated after cleanup`
- `test_json_headless_login_emits_authorization_url_on_stderr`: `tests/auth.test.ts > login > --json with $name emits the authorization URL on stderr`
- `test_json_browser_login_keeps_stderr_empty`: `tests/auth.test.ts > login > --json with a browser keeps stderr empty`
- `test_save_api_key_keeps_previous_oauth_when_revocation_fails`: `tests/config.test.ts > save api key keeps previous oauth when revocation fails`
- `test_save_oauth_session_revokes_previous_before_overwrite`: `tests/config.test.ts > save oauth session revokes previous before overwrite`
- `test_save_oauth_session_keeps_previous_and_cleans_replacement_on_failure`: `tests/config.test.ts > save oauth session keeps previous and cleans replacement on failure`
- `test_malformed_expiry_refreshes_without_revoking_active_session`: `tests/config.test.ts > malformed expiry refreshes without revoking active session`
- `test_malformed_expiry_without_refresh_is_invalid`: `tests/config.test.ts > malformed expiry without refresh is invalid`
- `test_config_write_keeps_previous_file_when_atomic_replace_fails`: `tests/config.test.ts > config write keeps previous file when atomic replace fails`
- `test_parallel_expired_session_refreshes_once`: `tests/config.test.ts > parallel expired session refreshes once`
- `test_config_lock_serializes_separate_processes`: `tests/config.test.ts > config lock serializes separate processes`
- `test_refresh_failure_is_reported_and_preserves_session`: `tests/config.test.ts > refresh failure is reported and preserves session`
- `test_search_json_reports_refresh_failure_without_keyless_fallback`: `tests/auth.test.ts > search --json reports refresh failure without a keyless fallback`
- `test_api_key_login_json_reports_replacement_revocation_failure`: `tests/auth.test.ts > login > --api-key --json reports replacement revocation failure`
- `test_oauth_login_json_reports_replacement_revocation_failure`: `tests/auth.test.ts > login > oauth --json reports replacement revocation failure`
- `test_api_key_and_oauth_replace_each_other`: `tests/config.test.ts > api key and oauth replace each other`

## tests/test_output.py

- `test_piped_search_prints_full_urls_and_snippets`: `tests/render.test.ts > piped search prints full URLs and snippets`; also contract cases `search-one (plain)` and `search-two (plain)`
- `test_piped_extract_keeps_markdown_links_and_whole_page`: `tests/render.test.ts > piped extract keeps markdown links and the whole page`
- `test_piped_map_crawl_and_research`: `tests/crawl-map.test.ts > plain map output is the URLs joined by newlines`, `tests/crawl-map.test.ts > plain crawl output prints each page through echoPages`, `tests/research.test.ts > a first response that is already complete is printed without polling`; also contract cases `map (plain)`, `crawl (plain)` and `research-poll (plain)`
- `test_terminal_search_shows_full_url_on_one_line`: `tests/render.test.ts > terminal search shows the full URL on one line`
- `test_multi_query_runs_each_with_shared_options`: `tests/search.test.ts > multi-query runs each query with the shared options`
- `test_multi_query_keeps_keyless_cap_details`: `tests/search.test.ts > multi-query keeps keyless cap details`
- `test_generated_names_differ_within_the_same_second`: `tests/shared.test.ts > resolveOutput`
- `test_bare_output_saves_under_tavily_folder`: `tests/search.test.ts > bare -o saves under .tavily and still prints when piped`
- `test_explicit_output_path_is_unchanged`: `tests/search.test.ts > an explicit -o path is used as given`

## tests/test_update.py

- `test_fetch_latest_version_from_pypi`: `tests/update.test.ts > fetchLatestVersion > reads .version from the registry without following redirects` (npm registry instead of PyPI)
- `test_fetch_latest_version_rejects_invalid_response`: `tests/update.test.ts > fetchLatestVersion > an invalid version is rejected`
- `test_detect_install_managers`: dropped, Python-only mechanism (`sys.prefix`, the `INSTALLER` record, pip/pipx/uv layouts). npm-side detection is covered by the `tests/update.test.ts > detectInstall > ...` tests.
- `test_detect_pip_install_preserves_virtualenv_executable`: dropped, Python-only mechanism (virtualenv `sys.executable` for pip).
- `test_detect_editable_install_refuses_self_update`: `tests/update.test.ts > detectInstall > a checkout outside node_modules is a source install` and `tests/update.test.ts > detectInstall > an npm link symlink is a source install` (the Python test reads `direct_url.json`; the npm analogue is a checkout or `npm link`)
- `test_detect_vcs_install_refuses_self_update`: dropped, Python-only mechanism (`direct_url.json` `vcs_info`).
- `test_detect_local_wheel_install_refuses_self_update`: dropped, Python-only mechanism (`direct_url.json` for a local wheel).
- `test_detect_uv_receipt_preserves_custom_tool_dir`: dropped, Python-only mechanism (`uv-receipt.toml`, `UV_TOOL_DIR`).
- `test_detect_pipx_receipt_preserves_custom_home`: dropped, Python-only mechanism (`pipx_metadata.json`, `PIPX_HOME`).
- `test_detect_pipx_recovers_invoked_entrypoint_from_path`: dropped, Python-only mechanism (pipx entrypoint and `PIPX_BIN_DIR`).
- `test_detect_pipx_suffixed_install_uses_active_environment_name`: dropped, Python-only mechanism (pipx suffixed venv names).
- `test_detect_manager_refuses_unverified_binary_directory`: dropped, Python-only mechanism (`PIPX_BIN_DIR` / `UV_TOOL_BIN_DIR` verification).
- `test_detect_uvx_cache_environment_refuses_mutation`: `tests/update.test.ts > detectInstall > npx cache is blocked` (the uvx cache's npm analogue is the npx cache)
- `test_detect_uvx_takes_precedence_over_direct_url_install`: dropped, Python-only mechanism (uvx vs. `direct_url.json` precedence).
- `test_update_check_json_is_read_only`: `tests/update.test.ts > update command > --check --json is read-only`; also contract case `update-check --json`
- `test_update_check_does_not_require_manager_binary_directory`: dropped, Python-only mechanism (pipx/uv binary directory).
- `test_update_check_reports_source_install_as_blocked`: `tests/update.test.ts > update command > --check reports a source install as blocked`
- `test_update_check_human_does_not_recommend_blocked_self_update`: `tests/update.test.ts > update command > --check human output does not recommend a blocked self-update`
- `test_update_check_failure_is_structured`: `tests/update.test.ts > update command > check failure is structured and exits 4`
- `test_install_detection_failure_is_not_reported_as_network_error`: `tests/update.test.ts > update command > install detection failure is not reported as a network error`
- `test_update_does_nothing_when_current`: `tests/update.test.ts > update command > does nothing when current`
- `test_update_runs_detected_manager_and_verifies_version`: `tests/update.test.ts > update command > runs the detected manager and verifies the installed version`
- `test_update_refuses_editable_install`: `tests/update.test.ts > update command > refuses a blocked install with stage install_method`
- `test_update_reports_unsafe_manager_binary_directory`: dropped, Python-only mechanism (`PIPX_BIN_DIR` safety check).
- `test_update_refuses_uvx_cache_environment`: `tests/update.test.ts > update command > refuses a blocked install with stage install_method` (a blocked install, which is what npx and uvx both produce, never runs the manager)
- `test_update_failure_is_structured_and_sanitized`: `tests/update.test.ts > update command > update failure is structured and sanitized`
- `test_update_verifies_package_manager_changed_version`: `tests/update.test.ts > update command > verifies the manager changed the version`
- `test_update_surfaces_manager_hint_when_successful_upgrade_is_pinned`: `tests/update.test.ts > update command > surfaces the manager hint when a successful upgrade is pinned`
- `test_update_does_not_echo_non_hint_output_after_successful_noop`: `tests/update.test.ts > update command > does not echo non-hint output after a successful no-op`
