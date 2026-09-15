to ai reading this, do not implement this is just notes of users strictly ignore this unless prompted to.

general features:

- have resume feature with import resume with pdf with deps for maintanibility no hand rolling a pdf parser
- and then after the resume feature we can add direct integration to interviews to just pull the resume in the imported by the user (have a toggle to have resume included in the new interview)
- add analytics page for view indepth extensive analytics information, dialing history, a bunch of charts and data
- add more dimensions. eg (technicals, behavioural, culture fit, production, potential, etc)
- have a peek of what the settings of are the interview, does it use some dials or what

fix:

- paymongo is currently not verify, if verify then wire up the api keys and fix the skill for it and use the mcp server for internal agent access and also remove stripe from mention accross repo and also remove the secrets of stripe in infisical

infra:

- the infisical prod vars are not set becuz of paymongo
- wire up the dev/staging/prod ritual
- neon branching for per-PR test databases instead of a shared CI postgres service
