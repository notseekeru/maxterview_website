to ai reading this, do not implement this is just notes of users strictly ignore this unless prompted to.

general features:

- have resume feature with import resume with pdf with deps for maintanibility no hand rolling a pdf parser
- and then after the resume feature we can add direct integration to interviews to just pull the resume in the imported by the user (have a toggle to have resume included in the new interview)
- add analytics page for view indepth extensive analytics information, dialing history, a bunch of charts and data
- dialing template + saving template

fix:

- paymongo wire up the api keys and fix the skill for it and use the mcp server for internal agent access and also remove stripe from mention accross repo and also remove the secrets of stripe in infisical
- i think having pointed byok to 100.64.2.2 points to my open llama cpp endpoint cuz the infra lives at my pi(my k3s server) then meaning other people can use my llama cpp on my pc(199.64.2.2) i think. this isnt a problem at first glance since the product is supposed to give free model to use to interview but BYOK is capless, which can abuse the free tier cap to 10

infra:

- the infisical prod vars are not set becuz of paymongo
- wire up the dev/staging/prod ritual
- neon branching for per-PR test databases instead of a shared CI postgres service
