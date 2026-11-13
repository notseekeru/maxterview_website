# Endpoints, per page

### Home `/`

```mermaid
``flowchart LR
  %% Home
  HomePage["Home"] --> Home_UB["UsageBadge<br/>account menu, on tap"]
  HomePage --> Home_DS["DashboardStats"]
  HomePage --> Home_CF["CreateInterviewForm"]

  Home_UB --> Home_E1["GET /billing/usage<br/>1 stmt"]
  Home_DS --> Home_E2["GET /interviews<br/>50 rows to print 5, 1 stmt"]
  Home_DS --> Home_E3["GET /stats/dashboard<br/>1 stmt"]
  Home_CF --> Home_E4["GET /templates<br/>1 stmt"]
  Home_CF --> Home_E5["GET /resumes<br/>1 stmt"]

  Home_E1 --> Home_T1[("turn_usage<br/>llm_credentials<br/>subscriptions")]
  Home_E2 --> Home_T2[("interviews<br/>feedback")]
  Home_E3 --> Home_T2
  Home_E4 --> Home_T3[("interview_templates")]
  Home_E5 --> Home_T4[("resumes")]

  %% Interviews
  InterviewsPage["Interviews"] --> Interviews_UB["UsageBadge<br/>account menu, on tap"]
  InterviewsPage --> Interviews_IL["InterviewList<br/>loadMore, archive, delete"]
  InterviewsPage --> Interviews_CF["CreateInterviewForm"]

  Interviews_UB --> Interviews_E1["GET /billing/usage<br/>1 stmt"]
  Interviews_IL --> Interviews_E2["GET /interviews?archived<br/>50 per page, 1 stmt"]
  Interviews_IL --> Interviews_E3["POST or DELETE /archive<br/>1 stmt each"]
  Interviews_IL --> Interviews_E4["DELETE /interviews/&#123;id&#125;<br/>2 stmt"]
  Interviews_CF --> Interviews_E5["GET /templates<br/>1 stmt"]
  Interviews_CF --> Interviews_E6["GET /resumes<br/>1 stmt"]

  Interviews_E1 --> Interviews_T1[("turn_usage<br/>subscriptions")]
  Interviews_E2 --> Interviews_T2[("interviews<br/>feedback")]
  Interviews_E3 --> Interviews_T2
  Interviews_E4 --> Interviews_T2
  Interviews_E5 --> Interviews_T3[("interview_templates")]
  Interviews_E6 --> Interviews_T4[("resumes")]

  %% Analytics
  AnalyticsPageRoot["Analytics"] --> Analytics_UB["UsageBadge<br/>account menu, on tap"]
  AnalyticsPageRoot --> Analytics_AP["AnalyticsPage"]

  Analytics_UB --> Analytics_E1["GET /billing/usage<br/>1 stmt"]
  Analytics_AP --> Analytics_E2["GET /stats/analytics<br/>1 stmt"]

  Analytics_E1 --> Analytics_T1[("turn_usage")]
  Analytics_E2 ==> Analytics_T2[("chat_turns<br/>every message ever written")]
  Analytics_E2 --> Analytics_T3[("interviews")]
  Analytics_E2 --> Analytics_T4[("feedback")]
  Analytics_E2 --> Analytics_T5[("offers")]

  subgraph Analytics_Shows["fed by that one scan"]
    Analytics_S1["Answers given"]
    Analytics_S2["Move breakdown"]
  end
  Analytics_E2 --> Analytics_S1
  Analytics_E2 --> Analytics_S2

  %% InterviewChat
  ChatPage["InterviewChat"] --> Chat_UB["UsageBadge<br/>account menu, on tap"]
  ChatPage --> Chat_OP["on open"]
  ChatPage --> Chat_RUN["during the run"]
  ChatPage --> Chat_FI["on finish"]

  Chat_UB --> Chat_E0["GET /billing/usage<br/>1 stmt"]
  Chat_OP --> Chat_E1["GET /interviews/&#123;id&#125;<br/>1 stmt"]
  Chat_OP --> Chat_E2["GET /chat<br/>1 stmt"]
  Chat_OP --> Chat_E3["GET /feedback<br/>1 stmt"]
  Chat_OP --> Chat_E4["GET /offer<br/>1 stmt"]
  Chat_OP --> Chat_E5["GET /voice<br/>0 stmt"]

  Chat_RUN --> Chat_E6["POST /start<br/>1 stmt"]
  Chat_RUN --> Chat_E7["POST /chat/opening<br/>5 stmt"]
  Chat_RUN --> Chat_E8["POST /chat/send<br/>5 stmt per turn"]

  Chat_FI --> Chat_E9["POST /finish<br/>11 stmt"]
  Chat_FI --> Chat_E10["POST /feedback/generate<br/>redo only"]

  Chat_E0 --> Chat_T1[("turn_usage")]
  Chat_E1 --> Chat_T2[("interviews")]
  Chat_E2 --> Chat_T3[("chat_turns")]
  Chat_E3 --> Chat_T4[("feedback")]
  Chat_E4 --> Chat_T5[("offers")]
  Chat_E6 --> Chat_T2
  Chat_E7 --> Chat_T2
  Chat_E7 --> Chat_T3
  Chat_E8 --> Chat_T2
  Chat_E8 --> Chat_T3
  Chat_E8 --> Chat_T1
  Chat_E9 --> Chat_T2
  Chat_E9 --> Chat_T3
  Chat_E9 --> Chat_T4
  Chat_E9 -.-> Chat_T5
  Chat_E10 --> Chat_T2
  Chat_E10 --> Chat_T3
  Chat_E10 --> Chat_T4

  %% ResumePage
  ResumePageRoot["ResumePage"] --> Resume_UB["UsageBadge<br/>account menu, on tap"]
  ResumePageRoot --> Resume_RV["ResumeReviewView"]

  Resume_UB --> Resume_E1["GET /billing/usage<br/>1 stmt"]
  ResumePageRoot --> Resume_E2["GET /resumes<br/>1 stmt"]
  ResumePageRoot --> Resume_E3["POST /resumes/extract<br/>parse only"]
  ResumePageRoot --> Resume_E4["POST /resumes<br/>1 stmt"]
  ResumePageRoot --> Resume_E5["PUT or DELETE /resumes/&#123;id&#125;<br/>1 stmt"]
  Resume_RV --> Resume_E6["GET /resumes/&#123;id&#125;<br/>1 stmt"]
  Resume_RV --> Resume_E7["GET /resumes/&#123;id&#125;/review<br/>1 stmt"]
  Resume_RV --> Resume_E8["POST /resumes/&#123;id&#125;/review<br/>2 stmt"]
  Resume_RV --> Resume_E9["POST review/rewrite<br/>2 stmt"]
  Resume_RV --> Resume_E10["POST /resumes/preview<br/>pdflatex, 2 slots"]

  Resume_E1 --> Resume_T1[("turn_usage")]
  Resume_E2 --> Resume_T2[("resumes")]
  Resume_E3 --> Resume_PDF["pypdf<br/>bounded, not yet memory-safe"]
  Resume_E4 --> Resume_T2
  Resume_E5 --> Resume_T2
  Resume_E6 --> Resume_T2
  Resume_E7 --> Resume_T3[("resume_reviews")]
  Resume_E8 --> Resume_T2
  Resume_E8 --> Resume_T3
  Resume_E9 --> Resume_T2
  Resume_E9 --> Resume_T3
  Resume_E10 --> Resume_TEX["pdflatex<br/>503 when both slots busy"]

  %% BillingPage
  BillingPageRoot["BillingPage"] --> Billing_QC["QrCheckout"]
  BillingPageRoot --> Billing_UP["UpgradePendingNotice"]

  Billing_QC --> Billing_E1["POST /billing/checkout"]
  Billing_QC --> Billing_E2["GET /billing/usage<br/>every 4s while the modal is open"]
  Billing_UP --> Billing_E3["GET /billing/usage<br/>every 5s, up to 12 times"]
  BillingPageRoot --> Billing_E4["POST /billing/cancel"]

  Billing_E1 --> Billing_PM["PayMongo"]
  Billing_E4 --> Billing_PM
  Billing_E2 --> Billing_T1[("turn_usage<br/>subscriptions")]
  Billing_E3 --> Billing_T1
  Billing_PM -.-> Billing_WH["POST /billing/webhook<br/>payment.paid"]
  Billing_WH -.-> Billing_T1

  %% Settings
  SystemSettingsPage["System settings"] --> Settings_L["LLMProviderCard"]
  AccountSettingsPage["Account settings"] --> Settings_UB["UsageBadge<br/>account menu, on tap"]

  Settings_L --> Settings_E1["GET /settings/llm<br/>0 or 1 stmt"]
  Settings_L --> Settings_E2["PUT /settings/llm"]
  Settings_L --> Settings_E3["DELETE /settings/llm"]
  Settings_L --> Settings_E4["POST /settings/llm/test"]
  Settings_UB --> Settings_E5["GET /billing/usage<br/>1 stmt"]

  Settings_E1 --> Settings_T1[("llm_credentials")]
  Settings_E2 --> Settings_T1
  Settings_E3 --> Settings_T1
  Settings_E4 --> Settings_T1
```
