to ai reading this, do not implement this is just notes of users strictly ignore this unless prompted to.

general features:
have resume feature with import resume with pdf with deps for maintanibility no hand rolling a pdf parser
and then after the resume feature we can add direct integration to interviews to just pull the resume in the imported by the user (have a toggle to have resume included in the new interview)
the interview should contain additive prompts (wary of prompt injection), slidable level(level implemented but currently not sliding), company size (slidable but also can be only 1 same as level), cynicism(how kinda mean they are like kind with benefit of the doubt and neutral and mean because skeptical), toogle to turn on brutally honest mode, human mode (removes ai fluff, unstructured response, and remove ai phrasing and vocabulary, custom rubric maybe?(may need schema changes if custom rubric), and also custom chitchat, behavioral, technical sliders.

fix:
repair the prompt steps like i think it skips behavioral

infra:
contemplating---
currently thinking using terraform + helm with k3s + postgres pods pvc (using my local raspi5 on my network) [the most simple to integrate becuz i have k3s running]
or use cloud with but a little more complex if aws cuz if we use aws then we will need rds, bedrock ai, then ec2 instances
or maybe use cloud postgres like neon then aws lamba for serverless fuctions but more refactor of code
and also if we gonna we local ai on my pc then we need tailscale network on an ec2 instance or pods(if k3s or eks) or subnet something im not quite sure
