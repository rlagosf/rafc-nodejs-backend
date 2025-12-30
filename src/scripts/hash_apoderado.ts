import * as argon2 from "@node-rs/argon2";

async function main() {
  const plain = "RAFC2025!";
  const hash = await argon2.hash(plain);
  console.log(hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


//UPDATE apoderados_auth
//SET password_hash = '$argon2id$v=19$m=19456,t=2,p=1$GHvmaHaLIOy8qlKfedgaOA$VTTKy9Orp7AV3Ymq84ZVR/I1B7iqcgl6ZxyqxphodMs',
//    must_change_password = 1,
    //updated_at = NOW()
//WHERE rut_apoderado = '16978094';
