export interface AuthEmailEnv {
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
}

export interface AuthOtpEmail {
  email: string;
  otp: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });

/** Resend adapter at the auth-email seam. Better Auth never knows the vendor. */
export async function sendAuthOtp(env: AuthEmailEnv, data: AuthOtpEmail): Promise<void> {
  if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) {
    throw new Error("Email OTP is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM,
      to: [data.email],
      subject: `${data.otp} is your El Copero sign-in code`,
      text: `Your El Copero del Dota sign-in code is ${data.otp}. It expires in 5 minutes.`,
      html: `<p>Your El Copero del Dota sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${escapeHtml(data.otp)}</p><p>It expires in 5 minutes.</p>`,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Could not send auth email: ${response.status} ${detail}`);
  }
}
