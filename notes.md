> To AI reading this, do not implement. This is just notes of the user, strictly ignore this unless prompted to.

# FEATURES

- have resume feature with import resume with pdf with deps for maintanibility no hand rolling a pdf parser
- and then after the resume feature we can add direct integration to interviews to just pull the resume in the imported by the user (have a toggle to have resume included in the new interview)
- add analytics page for view indepth extensive analytics information, dialing history, a bunch of charts and data
- the voice feature and tts
- dialing template + saving template

# FIX

- i think having pointed byok to 100.64.2.2 points to my open llama cpp endpoint cuz the infra lives at my pi(my k3s server) then meaning other people can use my llama cpp on my pc(199.64.2.2) i think. this isnt a problem at first glance since the product is supposed to give free model to use to interview but BYOK is capless, which can abuse the free tier cap. deffered for now next priority
- fix the dark mode to make it default
- grill the plan and architecture and code
- the personalData in portfolio is bloated
- after wiring the observability pipeline, we can proceed to writing the blog, and then we finish resume and analytics page and then record with recordly for project portfolio asset and maxterview landing page video opener asset

# REFACTOR

# INFRA

- neon branching for per-PR test databases instead of a shared CI postgres service using personal verification just to double check what the ai has done

# PERSONAL ACCOMPLISHMENTS/STRUGGLES THAT GOT ME EXCITED AND THINKING

- because of my existing infra (k3s, terraform, gitops, auto commit pipeline and stuff) is the reason why i can ship fast and automate deployments in my work, reducing friction and im happy i did what i did before and so proud of my architecture
- mcp wiring to playwright, rassled with it non stop, made tradeoffs and decisions and research until agent can independantly see the dom
- clerk, stripe and paymongo and alot of wiring on the 3rd party side but worth it so it can be automated and review by AI and setup by AI removing friction from using browser just for configuration
- dev, stage, prod separation haves another mental model that im very excited to show off, staging is the one that needs to be injected into my brain so i can practice how production deployment works
- currently setting staging rn, i was suprised i needed a separate and extra environment for it. i made another separate module for it in isolation. i shouldve seen this coming this like staging should be isolated not shared, which makes sense but i seemed like i forgot for a moment lol.
- just finished my staging env, i have done alot of stuff that i supervised with my AI, alot of it just monitor what it does and guiding what it is struggling with. for example i needed him to reference the infisical vars, someone who probably vibecode would trust ai that it is not possible with infisical cli but i persisted and guided it(cuz i know why and what tool im using) and not guide me there to what its believe without proper research surface
- quite alot was added in my infrastructure but i try to maintain its isolation, clarity and cohesion at the same time while understanding my whole system no big deal just another mental model
- yeah this is a little bit of overengineer and i would probably turn this staging stuff of in the near future cuz i dont need it im a 1 man team and just doing this for fun and i have tradeoffs to manage and also this is not a real production product yet cuz i dont have users and stakes to hold
