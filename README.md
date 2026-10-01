# SDx-Add-Reviewer
Quick tool to add reviewers within review pane


When user is in a review document page, a new button pops up at the top right

<img width="956" height="561" alt="image" src="https://github.com/user-attachments/assets/e06929ec-8b28-4963-9b0e-33f317e6e4ef" />


First time the user runs the script they'll be prompted to run a database build. This looks thru the SDx site and indexes all users. 
It will auto select only Burns & McDonell employees only to prevent accidentally adding outside parties for a document review

<img width="1401" height="1052" alt="image" src="https://github.com/user-attachments/assets/27c0d398-4210-412e-9cf7-892b88b453e1" />


Once the database is built, user can add people to any review. The database should only be rebuilt once every couple weeks or if user is aware of new personnel added to SDx. 


<img width="3777" height="1794" alt="image" src="https://github.com/user-attachments/assets/2e669ef1-50f5-4f3e-8ec3-69b0cb6e0624" />

Main tab of the wizard will allow viewer to see who's already in the review, it should match the list in the review page. 
Then in "A", they can search new folks. The search is fuzzy so common misspellings are ok. 
USer can add favorites for quick access on other reviews in area "B"

Search results of people populate in "C". 

Once the user adds someone to the "queue" they'll show up in D. They can queue up as many people as they want. 

When ready, user can click on "Add reviewers". The process is then limited to SDx's backend, so it'll take about 3 seconds per person to add. 

Once done, user will be prompted to refresh the page to confirm new reviewers were added. 
