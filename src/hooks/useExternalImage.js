import { useState, useEffect } from 'react';
export const useExternalImage = (fetcher, deps) => {
    const [imageUrl, setImageUrl] = useState();
    useEffect(() => {
        let mounted = true;
        setImageUrl(undefined);
        fetcher().then(url => {
            if (mounted && url)
                setImageUrl(url);
        });
        return () => { mounted = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return imageUrl;
};
