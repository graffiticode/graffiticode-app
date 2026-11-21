## Welcome to Graffiticode

Graffiticode is a tool for programming web components and apis through task specific languages. It is first and foremost a collection of end-user programming languages with runtimes that are React components and GraphQL services.

By *end-user* we don't mean non-technical, but rather the user of the thing being programmed. Just as accountants are the end-users of the spreadsheets they create to do work for their customers, the designers and developers or whoever else are making software with Graffiticode are its end-users.

## Getting started

Get started by signing in to Graffiticode using your preferred Ethereum wallet. *MetaMask* and *Coinbase* are two of the more popular wallets.

After signing in, you can start building by navigating to the [**Tools**](/tools) tab, selecting a language, and start writing code.

> **What's missing?** There are of course many many more languages we could add to the current collection. What programmable components and apis would you like to see here? [**Send us a note!**](mailto:jeff@graffiticode.com?subject=Graffiticode%20language%20idea)

## Main ideas

Graffiticode is a **language-oriented** programming tool. At the core of every component and api is a task-oriented language that is used to customize its feel and function. On the frontend, code defines the initial state of user interface components. On the backend, code defines how data is transformed.

Framed using **MVC** ideas, you can think of the language as an abstract **model**, the frontend as the **view**, and the integration between them as the **controller**. Without specifying an implementation, the language defines an infinite class of models that is selected from by code in that language.

**Languages.** Thinking of language as an abstract model that is made concrete by code helps to illuminate the power of the language-oriented programming paradigm. It allows us to create meta-models for a class of models that are selected from later in the development process. It also makes model building more accessible to the non-developers who are often more proximate the problem spaces for which the models are being created.

**Tasks.** The components and apis are programmed with the [**Items**](/items) editor. Once programmed, the static state of the component or api is used to initialize them whereever and however they may be hosted.

**Compiles.** Code and data are compiled to data by being posted to a language service. Compiles are idemponent and thus yield the same output given the same input. This allows us to identify and cache the output of compiles by a hash for their task language and code and data. The [**Tasks**](/tasks) tab shows the cached compiles performed through the *Graffiticode Console* and *API Gateway*.

## Hosting

React components are installed using your chosen *npm* package installer. GraphQL services are either self-hosted or managed by an hosting provider such as Graffiticode.