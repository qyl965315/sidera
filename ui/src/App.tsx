import {useLocation} from 'react-router-dom';
import ProductApp from './ProductApp';
import ConsoleApp from './ConsoleApp';

/** The Console is observation-first. Legacy administration remains available
 * only after an explicit Advanced choice; no task/identity/composer start page.
 * Keeping it here preserves the existing reviewed Human approval functionality.
 */
export default function App(){
 const location=useLocation();
 return new URLSearchParams(location.search).get('technical')==='1'
   ? <ProductApp/> : <ConsoleApp/>;
}
