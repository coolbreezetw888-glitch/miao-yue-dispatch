// SPECS-INDEX #1054(網站拆檔):「公開頁」分組 —— 首頁、登入、註冊、忘記密碼、隱私權、服務條款,
// 以及兩個獨立的帳號流程頁(登入信箱變更確認、重設密碼)。App.tsx 對這支檔案做同一個動態 import,
// 打包工具就會把這幾頁放進同一個分檔(用到才下載,客人預約頁不會下載這一包)。
export { default as Landing } from "@/routes/index";
export { default as SignIn } from "@/routes/signin";
export { default as SignUp } from "@/routes/signup";
export { default as ForgotPassword } from "@/routes/forgot-password";
export { default as Privacy } from "@/routes/privacy";
export { default as Terms } from "@/routes/terms";
export { default as EmailChangeConfirmedPage } from "@/modules/auth/EmailChangeConfirmedPage";
export { default as ResetPasswordPage } from "@/modules/auth/ResetPasswordPage";
