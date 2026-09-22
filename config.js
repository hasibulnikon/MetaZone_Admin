// PUBLIC configuration only. The publishable key is designed to be public.
// NEVER put a secret / service_role key in this file -- the admin site does not need one:
// every admin action is a database function that checks "is this signed-in user an admin?" on the server.
window.MZ_ADMIN_CONFIG = {
  supabaseUrl: "https://drqgsowdwbmwibjcyrpv.supabase.co",
  publishableKey: "sb_publishable_AtaDmS80VIefa9i_21JItw_B88wp0eF"
};
