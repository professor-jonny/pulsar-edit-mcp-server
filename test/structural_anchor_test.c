/* ======================================================================
 * WIFI CONFIG
 * ====================================================================== */
int wifi_cfg_a = 1;

/* ======================================================================
 * WIFI CONFIG LEGACY
 * ====================================================================== */
int wifi_cfg_legacy = 2;

/* ---- UNIQUE BANNER ---- */
int unique_banner_val = 3;

#ifdef CONFIG_NET_X
int net_x = 4;
#endif /* CONFIG_NET_X */

#ifdef CONFIG_NET_X_DEBUG
int net_x_dbg = 5;
#endif /* CONFIG_NET_X_DEBUG */

#ifdef CONFIG_SOLO
int solo = 6;
#endif /* CONFIG_SOLO */

int tail_marker = 7;
