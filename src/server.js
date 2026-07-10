require("dotenv").config();
const app = require("./app");
const { configureBountyStorageFromEnv } = require("./lib/supabaseStorage");

const PORT = process.env.PORT || 3000;

// Wire the real Supabase Storage client into the bounty-image upload seam.
// Fails loud if SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY
// are missing — never boot with an unconfigured upload path.
configureBountyStorageFromEnv();

app.listen(PORT, () => {
    console.log(`Bearbricks API running at http://localhost:${PORT}`);
});
